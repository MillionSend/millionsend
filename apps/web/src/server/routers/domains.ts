import { env } from "@millionsend/config";
import { type Db, schema } from "@millionsend/db";
import {
  createDomainIdentity,
  createSesv2Client,
  type DkimVerificationStatus,
  deleteDomainIdentity,
  dnsRecordsForDomain,
  getDomainVerification,
  type SesIdentityClient,
} from "@millionsend/ses";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { DOMAIN_REGIONS } from "@/app/(dashboard)/domains/regions";
import { isUniqueViolation } from "@/lib/db-errors";
import { router, teamProcedure } from "../trpc";

// Lowercase registrable hostname with at least two labels; SES identities are
// registered exactly as typed, so uppercase is rejected instead of normalized.
const HOSTNAME_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * SES access seam: the router only sees this interface, so tests inject a
 * fake via createDomainsRouter(deps) instead of stubbing the AWS SDK.
 */
export interface DomainsSesDeps {
  clientForRegion(region: string): SesIdentityClient;
}

const regionClients = new Map<string, SesIdentityClient>();

const defaultSesDeps: DomainsSesDeps = {
  // One client per region: identities live in the domain's region, which may
  // differ from AWS_REGION. Credentials fall back to the default provider chain.
  clientForRegion(region) {
    let client = regionClients.get(region);
    if (!client) {
      client = createSesv2Client({
        region,
        ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
          ? {
              accessKeyId: env.AWS_ACCESS_KEY_ID,
              secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
            }
          : {}),
      });
      regionClients.set(region, client);
    }
    return client;
  },
};

type DomainStatus = (typeof schema.domainStatusEnum.enumValues)[number];

function statusFromVerification(v: {
  dkimStatus: DkimVerificationStatus;
  verifiedForSending: boolean;
}): DomainStatus {
  if (v.dkimStatus === "SUCCESS" && v.verifiedForSending) return "verified";
  if (v.dkimStatus === "FAILED") return "failed";
  if (v.dkimStatus === "TEMPORARY_FAILURE") return "temporary_failure";
  return "pending";
}

async function requireDomain(db: Db, teamId: string, id: string) {
  const [domain] = await db
    .select()
    .from(schema.domains)
    .where(and(eq(schema.domains.id, id), eq(schema.domains.teamId, teamId)));
  if (!domain) throw new TRPCError({ code: "NOT_FOUND" });
  return domain;
}

export function createDomainsRouter(deps: DomainsSesDeps = defaultSesDeps) {
  return router({
    list: teamProcedure.query(({ ctx }) =>
      ctx.db
        .select({
          id: schema.domains.id,
          name: schema.domains.name,
          region: schema.domains.region,
          status: schema.domains.status,
          createdAt: schema.domains.createdAt,
        })
        .from(schema.domains)
        .where(eq(schema.domains.teamId, ctx.teamId))
        .orderBy(desc(schema.domains.createdAt)),
    ),

    get: teamProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
      const domain = await requireDomain(ctx.db, ctx.teamId, input.id);
      return {
        id: domain.id,
        name: domain.name,
        region: domain.region,
        status: domain.status,
        mailFromSubdomain: domain.mailFromSubdomain,
        createdAt: domain.createdAt,
        verifiedAt: domain.verifiedAt,
        lastCheckedAt: domain.lastCheckedAt,
      };
    }),

    create: teamProcedure
      .input(
        z.object({
          name: z
            .string()
            .trim()
            .refine((v) => HOSTNAME_RE.test(v), "must be a lowercase hostname"),
          region: z.enum(DOMAIN_REGIONS),
          mailFromSubdomain: z
            .string()
            .trim()
            .refine((v) => SUBDOMAIN_RE.test(v), "must be a lowercase DNS label")
            .default("send"),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const [existing] = await ctx.db
          .select({ id: schema.domains.id })
          .from(schema.domains)
          .where(and(eq(schema.domains.teamId, ctx.teamId), eq(schema.domains.name, input.name)));
        if (existing) throw new TRPCError({ code: "CONFLICT", message: "domain already added" });

        const { dkimTokens } = await createDomainIdentity(deps.clientForRegion(input.region), {
          domain: input.name,
          mailFromSubdomain: input.mailFromSubdomain,
        });

        let created: { id: string } | undefined;
        try {
          [created] = await ctx.db
            .insert(schema.domains)
            .values({
              teamId: ctx.teamId,
              name: input.name,
              region: input.region,
              mailFromSubdomain: input.mailFromSubdomain,
              dkimTokens,
            })
            .returning({ id: schema.domains.id });
        } catch (error) {
          // The pre-check above races with concurrent submits: the losing
          // insert hits the (teamId, name) unique index, which is the same
          // "already added" condition, not an internal failure.
          if (isUniqueViolation(error)) {
            throw new TRPCError({ code: "CONFLICT", message: "domain already added" });
          }
          throw error;
        }
        if (!created) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        return { id: created.id };
      }),

    records: teamProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
      const domain = await requireDomain(ctx.db, ctx.teamId, input.id);
      // Tokens are read live: SES can rotate Easy DKIM tokens, and older rows
      // may predate token persistence. The stored copy is only a fallback.
      const verification = await getDomainVerification(deps.clientForRegion(domain.region), {
        domain: domain.name,
      });
      const dkimTokens = verification.dkimTokens.length
        ? verification.dkimTokens
        : (domain.dkimTokens ?? []);
      return {
        records: dnsRecordsForDomain({
          domain: domain.name,
          dkimTokens,
          mailFromSubdomain: domain.mailFromSubdomain,
          region: domain.region,
        }),
      };
    }),

    verify: teamProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
      const domain = await requireDomain(ctx.db, ctx.teamId, input.id);
      const verification = await getDomainVerification(deps.clientForRegion(domain.region), {
        domain: domain.name,
      });
      const status = statusFromVerification(verification);
      const now = new Date();
      await ctx.db
        .update(schema.domains)
        .set({
          status,
          lastCheckedAt: now,
          ...(status === "verified" && !domain.verifiedAt ? { verifiedAt: now } : {}),
        })
        .where(and(eq(schema.domains.id, domain.id), eq(schema.domains.teamId, ctx.teamId)));
      return {
        status,
        dkimStatus: verification.dkimStatus,
        mailFromStatus: verification.mailFromStatus,
        verifiedForSending: verification.verifiedForSending,
      };
    }),

    delete: teamProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
      const domain = await requireDomain(ctx.db, ctx.teamId, input.id);
      try {
        await deleteDomainIdentity(deps.clientForRegion(domain.region), { domain: domain.name });
      } catch (error) {
        // An identity already gone from SES must not block removing the row.
        if ((error as { name?: string }).name !== "NotFoundException") throw error;
      }
      await ctx.db
        .delete(schema.domains)
        .where(and(eq(schema.domains.id, domain.id), eq(schema.domains.teamId, ctx.teamId)));
      return { id: domain.id };
    }),
  });
}

export const domainsRouter = createDomainsRouter();
