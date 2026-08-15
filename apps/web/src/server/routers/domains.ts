import { resolveNs as dnsResolveNs } from "node:dns/promises";
import { env } from "@millionsend/config";
import { type Db, schema } from "@millionsend/db";
import {
  createDomainIdentity,
  createSesv2Client,
  DKIM_SELECTOR,
  type DkimVerificationStatus,
  deleteDomainIdentity,
  dnsRecordsForDomain,
  generateDkimKeyPair,
  getDomainVerification,
  type SesIdentityClient,
} from "@millionsend/ses";
import { TRPCError } from "@trpc/server";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { DOMAIN_REGIONS } from "@/app/(dashboard)/domains/regions";
import { isUniqueViolation } from "@/lib/db-errors";
import { router, teamProcedure } from "../trpc";

// Lowercase registrable hostname with at least two labels; SES identities are
// registered exactly as typed, so uppercase is rejected instead of normalized.
const HOSTNAME_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * SES/DNS access seam: the router only sees this interface, so tests inject a
 * fake via createDomainsRouter(deps) instead of stubbing the AWS SDK or DNS.
 */
export interface DomainsSesDeps {
  clientForRegion(region: string): SesIdentityClient;
  resolveNs(name: string): Promise<string[]>;
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
  resolveNs: (name) => dnsResolveNs(name),
};

/**
 * NS host suffix → provider shown in the records heading ("Add these records
 * at Cloudflare") and the "Go to <provider> ↗" button. url only where the DNS
 * dashboard has a stable well-known address.
 */
const NS_PROVIDERS: readonly (readonly [suffix: string, name: string, url?: string])[] = [
  ["cloudflare.com", "Cloudflare", "https://dash.cloudflare.com"],
  ["registro.br", "Registro.br", "https://registro.br/painel/"],
  ["awsdns", "Route 53", "https://console.aws.amazon.com/route53/"],
  ["domaincontrol.com", "GoDaddy", "https://dcc.godaddy.com"],
  ["vercel-dns.com", "Vercel", "https://vercel.com/domains"],
  ["squarespacedns.com", "Squarespace"],
  ["digitalocean.com", "DigitalOcean"],
  ["porkbun.com", "Porkbun"],
  ["azure-dns.", "Azure DNS"],
  ["locaweb.com.br", "Locaweb"],
  ["hostgator", "HostGator"],
];

export type DnsProvider = { name: string; url?: string };

export function providerFromNs(hosts: string[]): DnsProvider | null {
  for (const host of hosts) {
    const lower = host.toLowerCase();
    for (const [suffix, name, url] of NS_PROVIDERS) {
      if (lower.includes(suffix)) return url ? { name, url } : { name };
    }
  }
  return null;
}

/**
 * NS records live at the zone apex, not the sending subdomain: walk up the
 * labels and take the deepest zone cut that answers. Best-effort — any DNS
 * failure means "provider unknown", never a query error.
 */
async function detectProvider(
  resolve: DomainsSesDeps["resolveNs"],
  domain: string,
): Promise<DnsProvider | null> {
  let labels = domain.split(".");
  while (labels.length >= 2) {
    try {
      const hosts = await resolve(labels.join("."));
      if (hosts.length > 0) return providerFromNs(hosts);
    } catch {
      // NODATA/NXDOMAIN at this depth — try the parent zone.
    }
    labels = labels.slice(1);
  }
  return null;
}

type DomainStatus = (typeof schema.domainStatusEnum.enumValues)[number];

/** DNS checklist rows plus the optional branded-tracking CNAME the UI table renders. */
type TrackedDnsRecord = {
  group: "verification" | "sending" | "dmarc" | "tracking";
  type: string;
  name: string;
  value: string;
  priority?: number;
  status: "verified" | "pending" | "failed" | null;
};

/** Per-record check state: verification rows follow DKIM, sending rows follow MAIL FROM. */
function recordCheck(sesStatus: string): "verified" | "pending" | "failed" {
  if (sesStatus === "SUCCESS") return "verified";
  if (sesStatus === "FAILED") return "failed";
  return "pending";
}

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
      const [sent] = await ctx.db
        .select({ n: count() })
        .from(schema.emails)
        .where(and(eq(schema.emails.teamId, ctx.teamId), eq(schema.emails.domainId, domain.id)));
      return {
        sentCount: sent?.n ?? 0,
        id: domain.id,
        name: domain.name,
        region: domain.region,
        status: domain.status,
        mailFromSubdomain: domain.mailFromSubdomain,
        openTracking: domain.openTracking,
        clickTracking: domain.clickTracking,
        trackingSubdomain: domain.trackingSubdomain,
        tlsMode: domain.tlsMode,
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

        // BYODKIM: the private key lives only in this block — handed to SES,
        // then dereferenced. It must never be stored, returned, or logged.
        let dkim: ReturnType<typeof generateDkimKeyPair> | null = generateDkimKeyPair();
        const dkimPublicKey = dkim.publicKeyB64;
        await createDomainIdentity(deps.clientForRegion(input.region), {
          domain: input.name,
          mailFromSubdomain: input.mailFromSubdomain,
          dkim: { selector: DKIM_SELECTOR, privateKeyB64: dkim.privateKeyB64 },
        });
        dkim = null;

        let created: { id: string } | undefined;
        try {
          [created] = await ctx.db
            .insert(schema.domains)
            .values({
              teamId: ctx.teamId,
              name: input.name,
              region: input.region,
              mailFromSubdomain: input.mailFromSubdomain,
              dkimSelector: DKIM_SELECTOR,
              dkimPublicKey,
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
      // The DKIM TXT derives from the stored selector + public key (BYODKIM
      // keys never rotate behind our back); SES is only asked for statuses.
      const [verification, provider] = await Promise.all([
        getDomainVerification(deps.clientForRegion(domain.region), { domain: domain.name }),
        detectProvider(deps.resolveNs, domain.name),
      ]);
      const records: TrackedDnsRecord[] = dnsRecordsForDomain({
        domain: domain.name,
        // The columns are nullable only for bare fixture inserts; every row
        // created through this router carries both values.
        dkimSelector: domain.dkimSelector ?? DKIM_SELECTOR,
        dkimPublicKey: domain.dkimPublicKey ?? "",
        mailFromSubdomain: domain.mailFromSubdomain,
        region: domain.region,
      }).map((record) => ({
        ...record,
        // DMARC is recommended-only: SES never checks it, so it carries no state.
        status:
          record.group === "verification"
            ? recordCheck(verification.dkimStatus)
            : record.group === "sending"
              ? recordCheck(verification.mailFromStatus)
              : null,
      }));

      // A branded tracking subdomain points at SES's regional open/click
      // endpoint (r.<region>.awstrack.me). SES exposes no verification state
      // for it, so it carries no status — like DMARC.
      if (domain.trackingSubdomain) {
        records.push({
          group: "tracking",
          type: "CNAME",
          name: `${domain.trackingSubdomain}.${domain.name}`,
          value: `r.${domain.region}.awstrack.me`,
          status: null,
        });
      }

      return { provider, records };
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

    updateConfiguration: teamProcedure
      .input(
        z.object({
          id: z.uuid(),
          openTracking: z.boolean().optional(),
          clickTracking: z.boolean().optional(),
          // Empty string clears the custom subdomain; any other value must be a
          // single lowercase DNS label (the CNAME host under the domain).
          trackingSubdomain: z
            .string()
            .trim()
            .refine((v) => v === "" || SUBDOMAIN_RE.test(v), "must be a lowercase DNS label")
            .nullable()
            .optional(),
          tlsMode: z.enum(schema.tlsModeEnum.enumValues).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const domain = await requireDomain(ctx.db, ctx.teamId, input.id);
        const set: Partial<{
          openTracking: boolean;
          clickTracking: boolean;
          trackingSubdomain: string | null;
          tlsMode: (typeof schema.tlsModeEnum.enumValues)[number];
        }> = {};
        if (input.openTracking !== undefined) set.openTracking = input.openTracking;
        if (input.clickTracking !== undefined) set.clickTracking = input.clickTracking;
        if (input.trackingSubdomain !== undefined) {
          set.trackingSubdomain = input.trackingSubdomain || null;
        }
        if (input.tlsMode !== undefined) set.tlsMode = input.tlsMode;
        const next = { ...domain, ...set };
        if (Object.keys(set).length > 0) {
          await ctx.db
            .update(schema.domains)
            .set(set)
            .where(and(eq(schema.domains.id, domain.id), eq(schema.domains.teamId, ctx.teamId)));
        }
        return {
          openTracking: next.openTracking,
          clickTracking: next.clickTracking,
          trackingSubdomain: next.trackingSubdomain,
          tlsMode: next.tlsMode,
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
      // api_keys.domainId is ON DELETE restrict: a key scoped to this domain
      // would block the delete, and set-null would silently widen it to an
      // all-domains key. So revoke every scoped key and drop its FK first — a
      // revoked key never authenticates, and clearing domainId frees the delete.
      await ctx.db
        .update(schema.apiKeys)
        .set({ revokedAt: new Date(), domainId: null })
        .where(and(eq(schema.apiKeys.teamId, ctx.teamId), eq(schema.apiKeys.domainId, domain.id)));
      await ctx.db
        .delete(schema.domains)
        .where(and(eq(schema.domains.id, domain.id), eq(schema.domains.teamId, ctx.teamId)));
      return { id: domain.id };
    }),
  });
}

export const domainsRouter = createDomainsRouter();
