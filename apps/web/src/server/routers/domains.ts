import { resolveNs as dnsResolveNs } from "node:dns/promises";
import {
  EMAIL_METADATA_RETENTION_DAYS_DEFAULT,
  EMAIL_RETENTION_DAYS_DEFAULT,
  env,
  receivingEnabled,
  receivingMxHost,
  servedRegions,
  sesTenantsEnabled,
  trackingCnameTarget,
  trackingSubdomainsSupported,
} from "@millionsend/config";
import {
  associateDomainTenant,
  clearTrackingClock,
  createFixedWindowLimiter,
  DAY_MS,
  DOMAIN_CREATE_LIMIT_PER_HOUR,
  deleteInboxes,
  enableWarmup,
  failQueuedEmailsForDomain,
  fetchEffectivePlan,
  getInstanceSettings,
  isIdentitySharedByOtherDomains,
  isOperatorTeam,
  isReservedSenderDomain,
  linkTeam,
  liveInbox,
  movedWarmupVolume,
  PLAN_DOMAIN_LIMIT,
  pauseWarmup,
  planWarmupDays,
  resultRows,
  resumeWarmup,
  setDomainReceiving,
  turnOffWarmup,
  updateWarmupSettings,
  utcDay,
  WARMUP_LIMITS,
  type WarmupOverview,
  warmupCap,
  warmupOverview,
  webhookBatch,
} from "@millionsend/core";
import { registrableDomain } from "@millionsend/core/org-domain";
import { type Db, schema } from "@millionsend/db";
import {
  checkDnsRecords,
  checkReceivingMx,
  computeDomainVerification,
  createDomainIdentity,
  createSesv2Client,
  DKIM_SELECTOR,
  type DnsResolver,
  deleteDomainIdentity,
  disassociateIdentity,
  dnsChecklist,
  generateDkimKeyPair,
  getDomainVerification,
  lookupDmarc,
  nodeDnsResolver,
  provisionDomainTenant,
  receivingDnsRecord,
  type SesIdentityClient,
  verificationDbPatch,
} from "@millionsend/ses";
import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, isNotNull, min, sql } from "drizzle-orm";
import { z } from "zod";
import { isUniqueViolation } from "@/lib/db-errors";
import { recordAudit } from "../audit";
import { resolveBaseUrl } from "../auth";
import { catchAllAllowed, inboxDeps, userActor } from "../inboxes";
import { enqueueDomainAge } from "../queue";
import { assertTeamNotSuspended } from "../suspension-lock";
import { adminProcedure, router, teamProcedure } from "../trpc";
import { signalViews, warmupTodayWindow } from "../warmup-view";
import { effectiveSetting } from "./system";

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
  /** The domain.age job, on create and verification; omitted, the worker's sweep asks later. */
  enqueueDomainAge?: (domainId: string) => Promise<void>;
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
  // Read at call time: a test's queue mock may not define it.
  enqueueDomainAge: (domainId) => enqueueDomainAge(domainId),
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

/**
 * The branded-tracking CNAME row once a subdomain is set. Engagement tracking
 * is app-layer: WE rewrite links and inject the open pixel, so the CNAME points
 * at THIS app (the /t/c and /t/o handlers serve on any host). A deployment that
 * cannot serve customer hostnames stops advertising the record, so a value
 * stored earlier no longer asks for DNS that buys nothing.
 */
function trackingCname(domain: {
  name: string;
  trackingSubdomain: string | null;
}): { type: "CNAME"; name: string; value: string } | null {
  return domain.trackingSubdomain && trackingSubdomainsSupported()
    ? {
        type: "CNAME",
        name: `${domain.trackingSubdomain}.${domain.name}`,
        value: trackingCnameTarget(resolveBaseUrl(env.APP_BASE_URL)),
      }
    : null;
}

/**
 * The Receiving MX row while the domain receives on an instance that takes
 * mail. Live-checked like the tracking CNAME, and like it never part of the
 * sending status.
 */
function receivingRecord(domain: { name: string; receivingEnabled: boolean }) {
  const mxHost = receivingMxHost();
  return mxHost && domain.receivingEnabled ? receivingDnsRecord(domain.name, mxHost) : null;
}

async function requireDomain(db: Db, teamId: string, id: string) {
  const [domain] = await db
    .select()
    .from(schema.domains)
    .where(and(eq(schema.domains.id, id), eq(schema.domains.teamId, teamId)));
  if (!domain) throw new TRPCError({ code: "NOT_FOUND" });
  return domain;
}

const WARMUP_ACTIONS = {
  on: enableWarmup,
  pause: pauseWarmup,
  resume: resumeWarmup,
  off: turnOffWarmup,
} as const;

const volumeInput = (limits: { min: number; max: number }) =>
  z.number().int().min(limits.min).max(limits.max).optional();
const warmupSettingsInput = z.object({
  dailyTarget: volumeInput(WARMUP_LIMITS.dailyTarget),
  startVolume: volumeInput(WARMUP_LIMITS.startVolume),
  orderByEngagement: z.boolean().optional(),
  orderByTransactional: z.boolean().optional(),
  orderProperty: z.string().trim().max(WARMUP_LIMITS.orderPropertyLength).nullable().optional(),
  skipInactive: z.boolean().optional(),
});

/** Today's sending window while warming and checked: until the mail waiting for today's room runs out. */
function todayWindow(o: WarmupOverview, now: Date) {
  const today = o.today;
  if (o.status !== "warming" || !today?.checked) return null;
  return warmupTodayWindow(today, Math.min(today.allowance - today.sent, o.waiting), now);
}

/** Days parked mail lasts: the body purge or the row purge, whichever comes first. */
async function mailRetentionDays(db: Db): Promise<number> {
  const stored = await getInstanceSettings(db);
  return Math.min(
    effectiveSetting(
      stored.emailRetentionDays,
      process.env.EMAIL_RETENTION_DAYS,
      EMAIL_RETENTION_DAYS_DEFAULT,
    ).value,
    effectiveSetting(
      null,
      process.env.EMAIL_METADATA_RETENTION_DAYS,
      EMAIL_METADATA_RETENTION_DAYS_DEFAULT,
    ).value,
  );
}

/** The property keys the team's contacts carry with a value, the ones the segment builder lists. */
async function contactPropertyKeys(db: Db, teamId: string): Promise<string[]> {
  const c = schema.contacts;
  const rows = resultRows<{ key: string }>(
    await db.execute(sql`
      select distinct kv.key as key
      from ${c} c
      cross join lateral jsonb_each_text(c.properties) as kv(key, value)
      where c.team_id = ${teamId} and kv.value <> ''
      order by 1
    `),
  );
  return rows.map((row) => row.key);
}

/** When this domain's oldest broadcast mail parked for its warm-up leaves with retention. */
async function waitingExpiresAt(db: Db, teamId: string, domainId: string): Promise<Date | null> {
  const e = schema.emails;
  const [[oldest], days] = await Promise.all([
    db
      .select({ at: min(e.createdAt) })
      .from(e)
      .where(
        and(
          eq(e.teamId, teamId),
          eq(e.domainId, domainId),
          eq(e.latestStatus, "queued_quota"),
          eq(e.parkReason, "warmup"),
          isNotNull(e.broadcastId),
        ),
      ),
    mailRetentionDays(db),
  ]);
  return oldest?.at ? new Date(oldest.at.getTime() + days * DAY_MS) : null;
}

export function createDomainsRouter(deps: DomainsSesDeps = defaultSesDeps) {
  // Identity creation provisions a shared AWS resource; cloud caps it per
  // team so one tenant cannot burn the account's CreateEmailIdentity
  // throttle for everyone.
  const createLimited = createFixedWindowLimiter(DOMAIN_CREATE_LIMIT_PER_HOUR, 3_600_000);
  return router({
    list: teamProcedure.query(async ({ ctx }) => {
      const rows = await ctx.db
        .select({
          id: schema.domains.id,
          name: schema.domains.name,
          region: schema.domains.region,
          status: schema.domains.status,
          createdAt: schema.domains.createdAt,
          trackingSubdomain: schema.domains.trackingSubdomain,
          trackingSubdomainSetAt: schema.domains.trackingSubdomainSetAt,
        })
        .from(schema.domains)
        .where(eq(schema.domains.teamId, ctx.teamId))
        .orderBy(desc(schema.domains.createdAt));
      // A set subdomain whose 72h clock is still armed has a CNAME nobody has
      // seen resolve: the domain sends, but not through its tracking host.
      return rows.map(({ trackingSubdomain, trackingSubdomainSetAt, ...row }) => ({
        ...row,
        trackingPending: trackingSubdomain !== null && trackingSubdomainSetAt !== null,
      }));
    }),

    get: teamProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
      const domain = await requireDomain(ctx.db, ctx.teamId, input.id);
      const [sent] = await ctx.db
        .select({ n: count() })
        .from(schema.emails)
        .where(and(eq(schema.emails.teamId, ctx.teamId), eq(schema.emails.domainId, domain.id)));
      const warmup = await warmupCap(ctx.db, {
        teamId: ctx.teamId,
        domainId: domain.id,
        at: new Date(),
      });
      const [inboxes] = await ctx.db
        .select({ n: count() })
        .from(schema.inboxes)
        .where(and(eq(schema.inboxes.domainId, domain.id), liveInbox(new Date())));
      return {
        sentCount: sent?.n ?? 0,
        // The day's cap while the domain warms up, when the calendar lifts
        // it, and whether the team's other new domains share the day's
        // volume; never why, nor what a tier is.
        warmup: warmup
          ? { perDay: warmup.cap, fullAt: warmup.fullAt, shared: warmup.poolDomains > 1 }
          : null,
        id: domain.id,
        name: domain.name,
        region: domain.region,
        status: domain.status,
        mailFromSubdomain: domain.mailFromSubdomain,
        openTracking: domain.openTracking,
        clickTracking: domain.clickTracking,
        trackingSubdomain: domain.trackingSubdomain,
        trackingPending:
          domain.trackingSubdomain !== null && domain.trackingSubdomainSetAt !== null,
        tlsMode: domain.tlsMode,
        receivingEnabled: domain.receivingEnabled,
        receivingCatchAll: domain.receivingCatchAll,
        // A stored true survives a downgrade; only turning it on needs the plan.
        catchAllAllowed: await catchAllAllowed(ctx.db, ctx.teamId),
        inboxCount: inboxes?.n ?? 0,
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
          region: z.string().trim(),
          mailFromSubdomain: z
            .string()
            .trim()
            .refine((v) => SUBDOMAIN_RE.test(v), "must be a lowercase DNS label")
            .default("send"),
          warmup: z.boolean().default(false),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        // env is read per call (not at module load) so tests can stub the
        // deployment mode first.
        const isCloud = Boolean(env.IS_CLOUD);
        // Any region this deployment serves — the list the form reads as
        // system.features.regions. Configuration sets, SNS topics and tenants
        // are regional, so an identity anywhere else would verify but never
        // send or report events.
        const regions = servedRegions();
        if (!regions.includes(input.region)) {
          throw new TRPCError({
            code: "UNPROCESSABLE_CONTENT",
            message: `Region ${input.region} is not available; this deployment serves ${regions.join(", ")}`,
          });
        }
        const isOperator = isCloud && (await isOperatorTeam(ctx.db, ctx.teamId));
        if (
          isReservedSenderDomain(input.name, {
            isCloud,
            authEmailFrom: env.AUTH_EMAIL_FROM,
            onboardingEmailFrom: env.ONBOARDING_EMAIL_FROM,
            notificationsEmailFrom: env.NOTIFICATIONS_EMAIL_FROM,
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
          // Every cloud tenant shares the SES account, so a domain another
          // team holds is taken in every served region: in the same region
          // adopting it would re-key their DKIM, and in another it would let
          // a second team stand up the same sender elsewhere.
          const [taken] = await ctx.db
            .select({ id: schema.domains.id })
            .from(schema.domains)
            .where(eq(schema.domains.name, input.name));
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
        if (input.warmup) await enableWarmup(ctx.db, { teamId: ctx.teamId, domainId: created.id });
        if (sesTenantsEnabled()) {
          const { id } = created;
          await associateDomainTenant(ctx.db, {
            domainId: id,
            teamId: ctx.teamId,
            name: input.name,
            region: input.region,
            configurationSet: env.SES_CONFIGURATION_SET,
            provision: () =>
              provisionDomainTenant(deps.clientForRegion(input.region), {
                teamId: ctx.teamId,
                region: input.region,
                domain: input.name,
                configurationSet: env.SES_CONFIGURATION_SET,
              }),
          });
        }
        await recordAudit(ctx, {
          action: "domain.created",
          target: { type: "domain", id: created.id },
          metadata: { name: input.name, region: input.region },
        });
        await deps.enqueueDomainAge?.(created.id);
        await linkTeam(ctx.db, { teamId: ctx.teamId, trigger: "domain" });
        return { id: created.id };
      }),

    records: teamProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
      const domain = await requireDomain(ctx.db, ctx.teamId, input.id);
      // The DKIM TXT derives from the stored selector + public key (BYODKIM
      // keys never rotate behind our back); SES is only asked for statuses.
      // Rows SES never checks (DMARC, tracking CNAME) have no stored gate, so a
      // page open would read them Pending until a Check DNS ran. Their live
      // verdict is read here instead — DMARC with the same organizational-domain
      // fallback the verify pass applies, so a refresh agrees with the check.
      const resolver = deps.dns ?? nodeDnsResolver;
      const tracking = trackingCname(domain);
      const receiving = receivingRecord(domain);
      const [verification, provider, dmarc, trackingLive, receivingLive] = await Promise.all([
        getDomainVerification(deps.clientForRegion(domain.region), { domain: domain.name }),
        detectProvider(deps.resolveNs, domain.name),
        lookupDmarc(domain.name, registrableDomain(domain.name), resolver),
        tracking ? checkDnsRecords([tracking], resolver).then(([status]) => status) : undefined,
        receiving ? checkReceivingMx(domain.name, receiving.value, resolver) : undefined,
      ]);
      // A CNAME seen live opens the branded-host gate here too, or the row would
      // read verified while sends still ship untracked.
      if (trackingLive === "found") await clearTrackingClock(ctx.db, domain);
      return {
        provider,
        records: [
          ...dnsChecklist({
            domain,
            verification,
            dmarc,
            tracking,
            live: tracking && trackingLive ? [{ ...tracking, status: trackingLive }] : [],
          }),
          ...(receiving && receivingLive
            ? [
                {
                  group: "receiving" as const,
                  ...receiving,
                  status: null,
                  live: receivingLive.status,
                  ...(receivingLive.found ? { found: receivingLive.found } : {}),
                },
              ]
            : []),
        ],
      };
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
      let trackingResolved = false;
      const cname = trackingCname(domain);
      if (cname) {
        const [live] = await checkDnsRecords([cname], resolver);
        liveDns.push({ ...cname, status: live ?? "missing" });
        trackingResolved = live === "found";
      }
      // The Receiving MX never gates status either; its row badge reads the same check.
      const receiving = receivingRecord(domain);
      if (receiving) {
        liveDns.push({
          ...receiving,
          ...(await checkReceivingMx(domain.name, receiving.value, resolver)),
        });
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
      if (trackingResolved) await clearTrackingClock(ctx.db, domain);
      if (status === "verified" && domain.status !== "verified") {
        await recordAudit(ctx, {
          action: "domain.verified",
          target: { type: "domain", id: domain.id },
          metadata: { name: domain.name },
        });
        await deps.enqueueDomainAge?.(domain.id);
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

    /** Everything the Warm-up tab and the status row above the tabs show, in one read. */
    warmup: teamProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
      const now = new Date();
      const [overview, properties, expiresAt] = await Promise.all([
        warmupOverview(ctx.db, { teamId: ctx.teamId, domainId: input.id, now }),
        contactPropertyKeys(ctx.db, ctx.teamId),
        waitingExpiresAt(ctx.db, ctx.teamId, input.id),
      ]);
      if (!overview) throw new TRPCError({ code: "NOT_FOUND" });
      const { days: allDays, pauseSignals, latestSignals: _, ...o } = overview;
      // A restart begins a new history: only the current run's days.
      const startDay = o.startedAt ? utcDay(o.startedAt) : null;
      const days = allDays
        .filter((d) => startDay !== null && d.day >= startDay)
        .map((d) => ({ ...d, signals: signalViews(d.signals) }));
      // The table reads the day that paused it, or else the newest one checked.
      const checked = days.find(
        (d) => d.signals && (o.status !== "paused" || (pauseSignals && d.outcome === "paused")),
      );
      return {
        ...o,
        days,
        pauseSignals: signalViews(pauseSignals),
        health: checked?.signals
          ? {
              day: checked.day,
              sent: checked.sent,
              checkedAt: checked.checkedAt,
              signals: checked.signals,
              yesterday: checked.day === utcDay(now.getTime() - DAY_MS),
            }
          : null,
        todayWindow: todayWindow(overview, now),
        resumeVolume: movedWarmupVolume(o.volume, "resume", o.settings.dailyTarget),
        // A broadcast to everyone while it is off, planned from the start of a
        // day so day 1 shows a whole day's volume however late it is now.
        preview:
          o.status === "off"
            ? planWarmupDays({
                now: new Date(`${utcDay(now)}T00:00:00Z`),
                paused: false,
                volume: o.settings.startVolume,
                dailyTarget: o.settings.dailyTarget,
                today: null,
                waitingAhead: 0,
                count: o.audience.total - (o.settings.skipInactive ? o.audience.inactive : 0),
              }).perDay
            : null,
        properties,
        limits: { dailyTarget: WARMUP_LIMITS.dailyTarget, startVolume: WARMUP_LIMITS.startVolume },
        waitingExpiresAt: o.waiting > 0 ? expiresAt : null,
        canManage: ctx.role === "owner" || ctx.role === "admin",
      };
    }),

    setWarmup: adminProcedure
      .input(z.object({ id: z.uuid(), action: z.enum(["on", "pause", "resume", "off"]) }))
      .mutation(async ({ ctx, input }) => {
        await requireDomain(ctx.db, ctx.teamId, input.id);
        const changed = await WARMUP_ACTIONS[input.action](ctx.db, {
          teamId: ctx.teamId,
          domainId: input.id,
        });
        return { changed };
      }),

    updateWarmup: adminProcedure
      .input(z.object({ id: z.uuid(), settings: warmupSettingsInput }))
      .mutation(async ({ ctx, input }) => {
        const saved = await updateWarmupSettings(ctx.db, {
          teamId: ctx.teamId,
          domainId: input.id,
          settings: input.settings,
        }).catch((error: unknown) => {
          // The input schema holds the bounds; what is left is a starting
          // volume above the daily target, against the stored other half.
          if (error instanceof RangeError) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "warmup_settings_out_of_range" });
          }
          throw error;
        });
        if (!saved) throw new TRPCError({ code: "NOT_FOUND" });
        return { id: input.id };
      }),

    /** Resend's capabilities.receiving: a catch-all for every address at the domain. */
    setReceiving: adminProcedure
      .input(z.object({ id: z.uuid(), enabled: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        if (!receivingEnabled()) {
          throw new TRPCError({
            code: "UNPROCESSABLE_CONTENT",
            message: "This instance does not receive mail",
          });
        }
        const result = await setDomainReceiving(ctx.db, {
          teamId: ctx.teamId,
          domainId: input.id,
          enabled: input.enabled,
        });
        if (result.ok) {
          if (result.changed) {
            await recordAudit(ctx, {
              action: result.receivingEnabled
                ? "domain.receiving_enabled"
                : "domain.receiving_disabled",
              target: { type: "domain", id: input.id },
              metadata: { name: result.name },
            });
          }
          return { receivingEnabled: result.receivingEnabled };
        }
        if (result.reason === "not_found") throw new TRPCError({ code: "NOT_FOUND" });
        throw result.reason === "not_verified"
          ? new TRPCError({ code: "PRECONDITION_FAILED", message: "Verify the domain first" })
          : new TRPCError({
              code: "CONFLICT",
              message: "Another team receives mail for this domain",
            });
      }),

    /** Mail to addresses without an inbox: stored in All received, or refused at RCPT. */
    setCatchAll: adminProcedure
      .input(z.object({ id: z.uuid(), enabled: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        if (!receivingEnabled()) {
          throw new TRPCError({
            code: "UNPROCESSABLE_CONTENT",
            message: "This instance does not receive mail",
          });
        }
        const domain = await requireDomain(ctx.db, ctx.teamId, input.id);
        if (input.enabled && !domain.receivingCatchAll) {
          if (!domain.receivingEnabled) {
            throw new TRPCError({
              code: "UNPROCESSABLE_CONTENT",
              message: "Turn on receiving for this domain first",
            });
          }
          // The plan cap's code, as domains.create answers it: FORBIDDEN is the tier's.
          if (!(await catchAllAllowed(ctx.db, ctx.teamId))) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "Catch-all receiving needs a paid plan",
            });
          }
        }
        if (domain.receivingCatchAll !== input.enabled) {
          await ctx.db
            .update(schema.domains)
            .set({ receivingCatchAll: input.enabled })
            .where(and(eq(schema.domains.id, domain.id), eq(schema.domains.teamId, ctx.teamId)));
          await recordAudit(ctx, {
            action: input.enabled ? "domain.catch_all_enabled" : "domain.catch_all_disabled",
            target: { type: "domain", id: domain.id },
            metadata: { name: domain.name },
          });
        }
        return { receivingCatchAll: input.enabled };
      }),

    delete: adminProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
      // While a suspended team holds a domain, cloud refuses the name to any
      // other team, so the domain cannot move to a fresh team and keep sending.
      await assertTeamNotSuspended(ctx.db, ctx.teamId, "deleteDomain");
      const domain = await requireDomain(ctx.db, ctx.teamId, input.id);
      // The SES identity is shared by every row with the same (name, region):
      // it goes only with the last of them.
      if (!(await isIdentitySharedByOtherDomains(ctx.db, domain))) {
        try {
          // Detach whenever tenants are on, not only when the row is marked:
          // the marker means the whole association (identity AND configuration
          // set) succeeded, but the identity is attached as soon as its own
          // association call returned — and SES refuses to delete an attached
          // identity. A tenant or association that is not there is tolerated.
          if (sesTenantsEnabled()) {
            await disassociateIdentity(deps.clientForRegion(domain.region), {
              tenantName: domain.teamId,
              region: domain.region,
              identity: domain.name,
            });
          }
          await deleteDomainIdentity(deps.clientForRegion(domain.region), { domain: domain.name });
        } catch (error) {
          // An identity already gone from SES must not block removing the row.
          if ((error as { name?: string }).name !== "NotFoundException") throw error;
        }
      }
      // The domain's inboxes go first, through the same path as deleting one:
      // their keys are revoked (api_keys.inbox_id is ON DELETE restrict),
      // webhook filters drop them and their events fire.
      const domainInboxes = await ctx.db
        .select({ id: schema.inboxes.id })
        .from(schema.inboxes)
        .where(and(eq(schema.inboxes.teamId, ctx.teamId), eq(schema.inboxes.domainId, domain.id)));
      if (domainInboxes.length > 0) {
        await deleteInboxes(ctx.db, inboxDeps(ctx), {
          teamId: ctx.teamId,
          inboxIds: domainInboxes.map((inbox) => inbox.id),
          actor: userActor(ctx),
          reason: "domain_deleted",
        });
      }
      const hooks = webhookBatch(ctx.enqueueWebhookDeliveries);
      await ctx.db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await failQueuedEmailsForDomain(txDb, {
          teamId: ctx.teamId,
          domainId: domain.id,
          enqueue: hooks.collect,
        });
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
      await hooks.flush();
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
