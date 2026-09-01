import { resolveNs as dnsResolveNs } from "node:dns/promises";
import { env, trackingCnameTarget, trackingSubdomainsSupported } from "@millionsend/config";
import {
  createFixedWindowLimiter,
  DOMAIN_CREATE_LIMIT_PER_HOUR,
  failQueuedEmailsForDomain,
  fetchEffectivePlan,
  isIdentitySharedByOtherDomains,
  isOperatorTeam,
  isReservedSenderDomain,
  PLAN_DOMAIN_LIMIT,
} from "@millionsend/core";
import { recordCheck } from "@millionsend/core/domain-status";
import { type Db, schema } from "@millionsend/db";
import {
  checkDnsRecords,
  computeDomainVerification,
  createDomainIdentity,
  createSesv2Client,
  DKIM_SELECTOR,
  type DnsResolver,
  deleteDomainIdentity,
  dnsRecordsForDomain,
  generateDkimKeyPair,
  getDomainVerification,
  nodeDnsResolver,
  type SesIdentityClient,
  verificationDbPatch,
} from "@millionsend/ses";
import { TRPCError } from "@trpc/server";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { DOMAIN_REGIONS } from "@/app/(dashboard)/domains/regions";
import { isUniqueViolation } from "@/lib/db-errors";
import { recordAudit } from "../audit";
import { resolveBaseUrl } from "../auth";
import { adminProcedure, router, teamProcedure } from "../trpc";

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
  /** Live per-record DNS lookups; omitted falls back to node:dns/promises. */
  dns?: DnsResolver;
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
  dns: nodeDnsResolver,
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

/** DNS checklist rows plus the optional branded-tracking CNAME the UI table renders. */
type TrackedDnsRecord = {
  group: "verification" | "sending" | "dmarc" | "tracking";
  type: string;
  name: string;
  value: string;
  priority?: number;
  status: "verified" | "pending" | "failed" | null;
};

/**
 * The domain's expected DNS checklist with each row's SES-derived status,
 * plus the branded-tracking CNAME once a subdomain is set. Shared by the
 * records query (what to add) and verify (what to live-check).
 */
function buildTrackedRecords(
  domain: {
    name: string;
    dkimSelector: string | null;
    dkimPublicKey: string | null;
    mailFromSubdomain: string;
    region: string;
    trackingSubdomain: string | null;
  },
  verification: { dkimStatus: string; mailFromStatus: string },
): TrackedDnsRecord[] {
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

  // Engagement tracking is app-layer: WE rewrite links and inject the open
  // pixel, so a branded tracking subdomain CNAMEs to THIS app (the /t/c and
  // /t/o handlers serve on any host). SES never checks it, so it carries no
  // SES status — like DMARC — but the live DNS check does resolve it. A
  // deployment that cannot serve customer hostnames stops advertising the
  // record, so a value stored earlier no longer asks for DNS that buys nothing.
  if (domain.trackingSubdomain && trackingSubdomainsSupported()) {
    records.push({
      group: "tracking",
      type: "CNAME",
      name: `${domain.trackingSubdomain}.${domain.name}`,
      value: trackingCnameTarget(resolveBaseUrl(env.APP_BASE_URL)),
      status: null,
    });
  }
  return records;
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
  // Identity creation provisions a shared AWS resource; cloud caps it per
  // team so one tenant cannot burn the account's CreateEmailIdentity
  // throttle for everyone.
  const createLimited = createFixedWindowLimiter(DOMAIN_CREATE_LIMIT_PER_HOUR, 3_600_000);
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

    create: adminProcedure
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
        // env is read per call (not at module load) so tests can stub the
        // deployment mode first.
        const isCloud = Boolean(env.IS_CLOUD);
        const isOperator = isCloud && (await isOperatorTeam(ctx.db, ctx.teamId));
        if (
          isReservedSenderDomain(input.name, {
            isCloud,
            authEmailFrom: env.AUTH_EMAIL_FROM,
            isOperator,
          })
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "This domain cannot be added as a sender",
          });
        }
        const [existing] = await ctx.db
          .select({ id: schema.domains.id })
          .from(schema.domains)
          .where(and(eq(schema.domains.teamId, ctx.teamId), eq(schema.domains.name, input.name)));
        if (existing) throw new TRPCError({ code: "CONFLICT", message: "domain already added" });
        if (isCloud) {
          // SES identities are account-wide per region and every cloud tenant
          // shares the account, so a domain another team holds in this region
          // is taken — adopting it would re-key their DKIM.
          const [taken] = await ctx.db
            .select({ id: schema.domains.id })
            .from(schema.domains)
            .where(
              and(eq(schema.domains.name, input.name), eq(schema.domains.region, input.region)),
            );
          if (taken) {
            throw new TRPCError({ code: "CONFLICT", message: "domain already registered" });
          }
          const plan = await fetchEffectivePlan(ctx.db, ctx.teamId);
          const limit = plan ? PLAN_DOMAIN_LIMIT[plan] : null;
          const [owned] = await ctx.db
            .select({ n: count() })
            .from(schema.domains)
            .where(eq(schema.domains.teamId, ctx.teamId));
          if (limit !== null && (owned?.n ?? 0) >= limit) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: `Your plan allows up to ${limit} domains`,
            });
          }
          if (createLimited(ctx.teamId)) {
            throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many domains created" });
          }
        }

        // BYODKIM: the private key lives only in this block — handed to SES,
        // then dereferenced. It must never be stored, returned, or logged.
        let dkim: ReturnType<typeof generateDkimKeyPair> | null = generateDkimKeyPair();
        const dkimPublicKey = dkim.publicKeyB64;
        try {
          await createDomainIdentity(deps.clientForRegion(input.region), {
            domain: input.name,
            mailFromSubdomain: input.mailFromSubdomain,
            dkim: { selector: DKIM_SELECTOR, privateKeyB64: dkim.privateKeyB64 },
            // Self-host: the whole AWS account is the operator's, so an
            // identity with no row (partial earlier create) is safe to adopt.
            adoptExisting: !isCloud,
          });
        } catch (error) {
          if ((error as { name?: string }).name === "AlreadyExistsException") {
            throw new TRPCError({ code: "CONFLICT", message: "domain already registered" });
          }
          throw error;
        }
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
        await recordAudit(ctx, {
          action: "domain.created",
          target: { type: "domain", id: created.id },
          metadata: { name: input.name, region: input.region },
        });
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
      return { provider, records: buildTrackedRecords(domain, verification) };
    }),

    verify: adminProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
      const domain = await requireDomain(ctx.db, ctx.teamId, input.id);
      const resolver = deps.dns ?? nodeDnsResolver;
      // The shared source of truth the worker cron also runs: SES status + live
      // DNS folded into the strict stored status the send gate keys off.
      const result = await computeDomainVerification(
        deps.clientForRegion(domain.region),
        resolver,
        domain,
      );
      const { status, liveDns, verification } = result;
      // The branded tracking CNAME never gates status, so computeDomainVerification
      // omits it — live-check it here so its row badge still reflects real DNS.
      if (domain.trackingSubdomain) {
        const cname = buildTrackedRecords(domain, verification).find((r) => r.group === "tracking");
        if (cname) {
          const [live] = await checkDnsRecords([cname], resolver);
          liveDns.push({
            type: cname.type,
            name: cname.name,
            value: cname.value,
            status: live ?? "missing",
          });
        }
      }
      const now = new Date();
      await ctx.db
        .update(schema.domains)
        .set({
          status,
          lastCheckedAt: now,
          ...verificationDbPatch(result, now),
          ...(status === "verified" && !domain.verifiedAt ? { verifiedAt: now } : {}),
        })
        .where(and(eq(schema.domains.id, domain.id), eq(schema.domains.teamId, ctx.teamId)));
      if (status === "verified" && domain.status !== "verified") {
        await recordAudit(ctx, {
          action: "domain.verified",
          target: { type: "domain", id: domain.id },
          metadata: { name: domain.name },
        });
      }
      return {
        status,
        dkimStatus: verification.dkimStatus,
        mailFromStatus: verification.mailFromStatus,
        verifiedForSending: verification.verifiedForSending,
        liveDns,
      };
    }),

    updateConfiguration: adminProcedure
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
          trackingSubdomainSetAt: Date | null;
          tlsMode: (typeof schema.tlsModeEnum.enumValues)[number];
        }> = {};
        if (input.openTracking !== undefined) set.openTracking = input.openTracking;
        if (input.clickTracking !== undefined) set.clickTracking = input.clickTracking;
        if (input.trackingSubdomain !== undefined) {
          // Clearing is always allowed; only adopting one needs the deployment
          // to be able to serve a customer hostname.
          if (input.trackingSubdomain && !trackingSubdomainsSupported()) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Branded tracking subdomains are not available on this deployment",
            });
          }
          // The tracking CNAME and the MAIL FROM (return-path) record would
          // collide on the same host, so they must be different labels.
          if (input.trackingSubdomain && input.trackingSubdomain === domain.mailFromSubdomain) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "The tracking subdomain must be different from the return-path subdomain",
            });
          }
          const nextSubdomain = input.trackingSubdomain || null;
          set.trackingSubdomain = nextSubdomain;
          // Arm the 72h auto-unset clock when a subdomain is newly adopted or
          // changed; clear it when the subdomain is removed. Re-saving the same
          // value leaves the running clock untouched.
          if (nextSubdomain === null) {
            set.trackingSubdomainSetAt = null;
          } else if (nextSubdomain !== domain.trackingSubdomain) {
            set.trackingSubdomainSetAt = new Date();
          }
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

    delete: adminProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
      const domain = await requireDomain(ctx.db, ctx.teamId, input.id);
      // The SES identity is shared by every row with the same (name, region):
      // it goes only with the last of them.
      if (!(await isIdentitySharedByOtherDomains(ctx.db, domain))) {
        try {
          await deleteDomainIdentity(deps.clientForRegion(domain.region), { domain: domain.name });
        } catch (error) {
          // An identity already gone from SES must not block removing the row.
          if ((error as { name?: string }).name !== "NotFoundException") throw error;
        }
      }
      await ctx.db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await failQueuedEmailsForDomain(txDb, { teamId: ctx.teamId, domainId: domain.id });
        // api_keys.domainId is ON DELETE restrict: a key scoped to this domain
        // would block the delete, and set-null would silently widen it to an
        // all-domains key. So revoke every scoped key and drop its FK first — a
        // revoked key never authenticates, and clearing domainId frees the delete.
        await txDb
          .update(schema.apiKeys)
          .set({ revokedAt: new Date(), domainId: null })
          .where(
            and(eq(schema.apiKeys.teamId, ctx.teamId), eq(schema.apiKeys.domainId, domain.id)),
          );
        await txDb
          .delete(schema.domains)
          .where(and(eq(schema.domains.id, domain.id), eq(schema.domains.teamId, ctx.teamId)));
      });
      await recordAudit(ctx, {
        action: "domain.deleted",
        target: { type: "domain", id: domain.id },
        metadata: { name: domain.name },
      });
      return { id: domain.id };
    }),
  });
}

export const domainsRouter = createDomainsRouter();
