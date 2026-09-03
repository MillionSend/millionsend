import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { trackingCnameTarget } from "@millionsend/config";
import {
  apiRequestActor,
  associateDomainTenant,
  createFixedWindowLimiter,
  DOMAIN_CREATE_LIMIT_PER_HOUR,
  failQueuedEmailsForDomain,
  isIdentitySharedByOtherDomains,
  isLoopbackUrl,
  isOperatorTeam,
  isReservedSenderDomain,
  PLAN_DOMAIN_LIMIT,
  recordAudit,
} from "@millionsend/core";
import { recordCheck } from "@millionsend/core/domain-status";
import { type Db, schema } from "@millionsend/db";
import {
  checkDnsRecords,
  computeDomainVerification,
  createDomainIdentity,
  DKIM_SELECTOR,
  type DnsResolver,
  type DomainVerification,
  deleteDomainIdentity,
  disassociateIdentity,
  dnsRecordsForDomain,
  generateDkimKeyPair,
  getDomainVerification,
  nodeDnsResolver,
  provisionDomainTenant,
  SES_REGIONS,
  type SesIdentityClient,
  verificationDbPatch,
} from "@millionsend/ses";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { type ApiDeps, type Env, errorBody, isUniqueViolation, keysetPage } from "../app.js";
import {
  createDomainRequestSchema,
  createDomainResponseSchema,
  errorSchema,
  getDomainResponseSchema,
  listDomainsResponseSchema,
  listQuerySchema,
  removeDomainResponseSchema,
  updateDomainRequestSchema,
} from "../schemas.js";

/**
 * SES/DNS access seam (mirrors the dashboard router's DomainsSesDeps in
 * apps/web/src/server/routers/domains.ts): handlers only see this interface,
 * so tests inject fakes instead of stubbing the AWS SDK or node:dns.
 */
export interface DomainsSesDeps {
  clientForRegion(region: string): SesIdentityClient;
  /** Live per-record DNS lookups; omitted falls back to node:dns/promises. */
  dns?: DnsResolver | undefined;
  /**
   * The SES region this deployment serves (AWS_REGION): the only region a
   * create accepts, and its default.
   */
  defaultRegion?: string | undefined;
  /** The AUTH_EMAIL_FROM sender; in cloud its domain is reserved for system mail. */
  authEmailFrom?: string | undefined;
  /** The ONBOARDING_EMAIL_FROM sender; reserved in cloud the same way. */
  onboardingEmailFrom?: string | undefined;
  /** The NOTIFICATIONS_EMAIL_FROM sender; reserved in cloud the same way. */
  notificationsEmailFrom?: string | undefined;
  /** Present = one SES tenant per team (SES_TENANTS); the shared configuration set to associate. */
  tenants?: { configurationSet?: string | undefined } | undefined;
}

type DomainRow = typeof schema.domains.$inferSelect;

/**
 * The SDK's DomainStatus union has no temporary_failure (that value exists
 * only per-record); SES is still retrying verification, so it reads as
 * pending on the wire.
 */
const wireDomainStatus = (status: string): string =>
  status === "temporary_failure" ? "pending" : status;

// SES-checklist group → the SDK's record discriminant. DMARC is a deliberate
// superset: the SDK union omits it, but hiding a recommended record from API
// consumers the dashboard shows would make the two surfaces disagree.
const RECORD_KIND: Record<string, string> = {
  verification: "DKIM",
  sending: "SPF",
  dmarc: "DMARC",
};

const toWire = (row: DomainRow) => ({
  id: row.id,
  name: row.name,
  status: wireDomainStatus(row.status),
  created_at: row.createdAt.toISOString(),
  region: row.region,
  open_tracking: row.openTracking,
  click_tracking: row.clickTracking,
  tracking_subdomain: row.trackingSubdomain,
  // Sending-only platform; present for SDK-shape parity.
  capabilities: { sending: "enabled", receiving: "disabled" },
});

/**
 * The guardrails on tracking settings, shared by create (no stored row: every
 * `current` value is off) and update (stored row + patch; `undefined` = field
 * not sent). Returns the 422 message, or null when the request is allowed.
 */
function trackingSettingsError(
  deps: Pick<ApiDeps, "appBaseUrl" | "trackingSubdomains" | "isCloud">,
  input: {
    open?: boolean | undefined;
    click?: boolean | undefined;
    subdomain?: string | null | undefined;
  },
  current: { open: boolean; click: boolean; subdomain: string | null; mailFromSubdomain: string },
): string | null {
  // Tracking is app-layer: open pixels, rewritten links, and the branded
  // CNAME all point at APP_BASE_URL. A host recipients cannot reach makes
  // the toggle meaningless, so enabling is refused — disabling is always
  // allowed.
  const enabling = input.open === true || input.click === true || Boolean(input.subdomain);
  if (enabling && !deps.appBaseUrl) {
    return "APP_BASE_URL is not set. Tracking URLs are served from it. Set it, restart, and try again.";
  }
  if (enabling && isLoopbackUrl(deps.appBaseUrl)) {
    return "APP_BASE_URL is a loopback address recipients cannot reach, so tracking cannot be enabled";
  }
  // Clearing is always allowed; adopting one needs a deployment that can
  // terminate TLS for the customer's own hostname.
  if (input.subdomain && deps.trackingSubdomains === false) {
    return "Branded tracking subdomains are not available on this deployment";
  }
  // The tracking CNAME and the MAIL FROM (return-path) record would collide
  // on the same host, so they must be different labels.
  if (input.subdomain && input.subdomain === current.mailFromSubdomain) {
    return "The tracking subdomain must be different from the return-path subdomain";
  }
  // Cloud serves tracking only from the domain's own subdomain (the worker
  // ships clean links without one), so a request that would leave either
  // kind on with no subdomain is refused instead of persisted as
  // enabled-but-unserved. Turning tracking off is always allowed.
  const keepsSubdomain =
    input.subdomain !== undefined ? Boolean(input.subdomain) : Boolean(current.subdomain);
  const leavesTrackingOn = (input.open ?? current.open) || (input.click ?? current.click);
  const enablingKind = input.open === true || input.click === true;
  const clearingSubdomain = input.subdomain !== undefined && !input.subdomain;
  if (
    deps.isCloud &&
    !keepsSubdomain &&
    (enablingKind || (clearingSubdomain && leavesTrackingOn))
  ) {
    return deps.trackingSubdomains === false
      ? "Tracking is served from the domain's own tracking subdomain, and this deployment cannot serve one, so tracking cannot be turned on."
      : 'Tracking is served from the domain\'s own tracking subdomain, so it cannot be on without one. Pass tracking_subdomain (a label such as "links") in the same request — the response includes the CNAME record to add — or turn both tracking kinds off first.';
  }
  return null;
}

/**
 * The domain's DNS checklist in the SDK's record shape. `verification` null =
 * SES not asked (create response): every row reads not_started. DMARC is never
 * checked by SES, so it always reads not_started; the tracking CNAME reads
 * pending until a verify or the reverify sweep sees it resolve, then verified.
 */
function wireRecords(
  domain: DomainRow,
  verification: DomainVerification | null,
  deps: Pick<ApiDeps, "appBaseUrl" | "trackingSubdomains">,
) {
  const status = (group: string): string => {
    if (!verification) return "not_started";
    if (group === "verification") return recordCheck(verification.dkimStatus);
    if (group === "sending") return recordCheck(verification.mailFromStatus);
    return "not_started";
  };
  const records = dnsRecordsForDomain({
    domain: domain.name,
    // Columns are nullable only for bare fixture inserts; the create flow
    // always sets both.
    dkimSelector: domain.dkimSelector ?? DKIM_SELECTOR,
    dkimPublicKey: domain.dkimPublicKey ?? "",
    mailFromSubdomain: domain.mailFromSubdomain,
    region: domain.region,
  }).map((r) => ({
    record: RECORD_KIND[r.group] ?? r.group,
    name: r.name,
    type: r.type as string,
    ttl: "Auto",
    status: status(r.group),
    value: r.value,
    ...(r.priority !== undefined ? { priority: r.priority } : {}),
  }));
  // Engagement tracking is app-layer: the branded CNAME points at THIS app
  // host, not SES — so it only exists once APP_BASE_URL names a real host, and
  // only where this deployment can actually serve a customer hostname.
  if (domain.trackingSubdomain && deps.appBaseUrl && deps.trackingSubdomains !== false) {
    records.push({
      record: "Tracking",
      name: `${domain.trackingSubdomain}.${domain.name}`,
      type: "CNAME",
      ttl: "Auto",
      // The 72h clock is cleared the first time the CNAME is seen to resolve.
      status: !verification
        ? "not_started"
        : domain.trackingSubdomainSetAt
          ? "pending"
          : "verified",
      value: trackingCnameTarget(deps.appBaseUrl),
    });
  }
  return records;
}

/**
 * The one SES region this deployment provisions identities in — the same
 * value the dashboard form reads as system.features.region. The configuration
 * set, SNS topics and tenants are regional, so a domain anywhere else would
 * verify but never send or report events.
 */
export function servedRegion(ses: Pick<DomainsSesDeps, "defaultRegion">): string {
  return ses.defaultRegion ?? "us-east-1";
}

export function registerDomainRoutes(
  app: OpenAPIHono<Env>,
  deps: ApiDeps,
  ses: DomainsSesDeps,
): void {
  const db = deps.db;
  const jsonErr = (description: string) => ({
    content: { "application/json": { schema: errorSchema } },
    description,
  });
  const idParam = z.object({ id: z.uuid() });
  const d = schema.domains;

  const served = servedRegion(ses);
  // Only the docs generator registers routes with no region configured; its
  // published schema then lists every region a deployment may serve.
  const createRequestSchema = createDomainRequestSchema(ses.defaultRegion ? [served] : SES_REGIONS);

  const findDomain = async (teamId: string, id: string): Promise<DomainRow | undefined> =>
    (
      await db
        .select()
        .from(d)
        .where(and(eq(d.id, id), eq(d.teamId, teamId)))
    )[0];

  // Identity creation is the one route that provisions a shared AWS resource;
  // cloud caps it per team so one tenant cannot burn the account's
  // CreateEmailIdentity throttle for everyone.
  const createLimited = createFixedWindowLimiter(DOMAIN_CREATE_LIMIT_PER_HOUR, 3_600_000);

  app.openapi(
    createRoute({
      method: "post",
      path: "/domains",
      request: {
        body: { content: { "application/json": { schema: createRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: createDomainResponseSchema } },
          description: "Domain created",
        },
        403: jsonErr("Plan domain limit reached"),
        409: jsonErr("Domain already added"),
        422: jsonErr("Validation error"),
        429: jsonErr("Too many domains created recently"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const body = c.req.valid("json");
      const region = body.region ?? served;
      const isOperator = deps.isCloud && (await isOperatorTeam(db, auth.teamId));
      if (
        isReservedSenderDomain(body.name, {
          isCloud: deps.isCloud,
          authEmailFrom: ses.authEmailFrom,
          onboardingEmailFrom: ses.onboardingEmailFrom,
          notificationsEmailFrom: ses.notificationsEmailFrom,
          isOperator,
        })
      ) {
        return c.json(
          errorBody(422, "validation_error", "This domain cannot be added as a sender"),
          422,
        );
      }
      // Checked before the SES identity exists: a refused tracking setting
      // must not leave a half-created domain behind.
      const trackingError = trackingSettingsError(
        deps,
        {
          open: body.open_tracking,
          click: body.click_tracking,
          subdomain: body.tracking_subdomain,
        },
        { open: false, click: false, subdomain: null, mailFromSubdomain: body.custom_return_path },
      );
      if (trackingError) {
        return c.json(errorBody(422, "validation_error", trackingError), 422);
      }
      const [existing] = await db
        .select({ id: d.id })
        .from(d)
        .where(and(eq(d.teamId, auth.teamId), eq(d.name, body.name)));
      if (existing) return c.json(errorBody(409, "conflict", "domain already added"), 409);
      if (deps.isCloud) {
        // SES identities are account-wide per region and every cloud tenant
        // shares the account, so a domain another team holds in this region
        // is taken — adopting it would re-key their DKIM.
        const [taken] = await db
          .select({ id: d.id })
          .from(d)
          .where(and(eq(d.name, body.name), eq(d.region, region)));
        if (taken) return c.json(errorBody(409, "conflict", "domain already registered"), 409);
        const limit = PLAN_DOMAIN_LIMIT[auth.plan];
        const [owned] = await db.select({ n: count() }).from(d).where(eq(d.teamId, auth.teamId));
        if (limit !== null && (owned?.n ?? 0) >= limit) {
          return c.json(
            errorBody(403, "plan_limit_reached", `Your plan allows up to ${limit} domains`),
            403,
          );
        }
        if (createLimited(auth.teamId)) {
          return c.json(errorBody(429, "rate_limit_exceeded", "Too many domains created"), 429);
        }
      }

      // BYODKIM: the private key lives only in this block — handed to SES,
      // then dereferenced. It must never be stored, returned, or logged.
      let dkim: ReturnType<typeof generateDkimKeyPair> | null = generateDkimKeyPair();
      const dkimPublicKey = dkim.publicKeyB64;
      try {
        await createDomainIdentity(ses.clientForRegion(region), {
          domain: body.name,
          mailFromSubdomain: body.custom_return_path,
          dkim: { selector: DKIM_SELECTOR, privateKeyB64: dkim.privateKeyB64 },
          // Self-host: the whole AWS account is the operator's, so an
          // identity with no row (partial earlier create) is safe to adopt.
          adoptExisting: !deps.isCloud,
        });
      } catch (error) {
        if ((error as { name?: string }).name === "AlreadyExistsException") {
          return c.json(errorBody(409, "conflict", "domain already registered"), 409);
        }
        throw error;
      }
      dkim = null;

      let row: DomainRow | undefined;
      try {
        [row] = await db
          .insert(d)
          .values({
            teamId: auth.teamId,
            name: body.name,
            region,
            mailFromSubdomain: body.custom_return_path,
            dkimSelector: DKIM_SELECTOR,
            dkimPublicKey,
            openTracking: body.open_tracking ?? false,
            clickTracking: body.click_tracking ?? false,
            trackingSubdomain: body.tracking_subdomain ?? null,
            // Same 72h auto-unset clock a later adopt would arm.
            trackingSubdomainSetAt: body.tracking_subdomain ? new Date() : null,
          })
          .returning();
      } catch (error) {
        // The pre-check above races with concurrent submits: the losing
        // insert hits the (teamId, name) unique index, which is the same
        // "already added" condition, not an internal failure.
        if (isUniqueViolation(error)) {
          return c.json(errorBody(409, "conflict", "domain already added"), 409);
        }
        throw error;
      }
      if (!row) throw new Error("domain insert returned no row");
      if (ses.tenants) {
        const configurationSet = ses.tenants.configurationSet;
        await associateDomainTenant(db, {
          domainId: row.id,
          teamId: auth.teamId,
          name: row.name,
          region,
          configurationSet,
          provision: () =>
            provisionDomainTenant(ses.clientForRegion(region), {
              teamId: auth.teamId,
              region,
              domain: row.name,
              configurationSet,
            }),
        });
      }
      await recordAudit(db, {
        teamId: auth.teamId,
        actor: apiRequestActor(auth),
        action: "domain.created",
        target: { type: "domain", id: row.id },
        metadata: { name: row.name, region },
      });
      return c.json({ ...toWire(row), records: wireRecords(row, null, deps) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/domains",
      request: { query: listQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: listDomainsResponseSchema } },
          description: "Domains",
        },
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const page = await keysetPage({
        query: c.req.valid("query"),
        createdAt: d.createdAt,
        id: d.id,
        loadCursor: async (id) =>
          (
            await db
              .select({ createdAt: d.createdAt, id: d.id })
              .from(d)
              .where(and(eq(d.id, id), eq(d.teamId, auth.teamId)))
          )[0],
        loadRows: (cond, descending, take) =>
          db
            .select()
            .from(d)
            .where(and(eq(d.teamId, auth.teamId), cond))
            .orderBy(
              ...(descending ? [desc(d.createdAt), desc(d.id)] : [asc(d.createdAt), asc(d.id)]),
            )
            .limit(take),
      });
      if (page === "bad_cursor") {
        return c.json(errorBody(422, "validation_error", "invalid pagination cursor"), 422);
      }
      return c.json(
        { object: "list" as const, data: page.rows.map(toWire), has_more: page.hasMore },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/domains/{id}",
      request: { params: idParam },
      responses: {
        200: {
          content: { "application/json": { schema: getDomainResponseSchema } },
          description: "Domain with its DNS records",
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const domain = await findDomain(auth.teamId, c.req.valid("param").id);
      if (!domain) return c.json(errorBody(404, "not_found", "Domain not found"), 404);
      // The DKIM TXT derives from the stored selector + public key; SES is
      // only asked for the per-record verification statuses.
      const verification = await getDomainVerification(ses.clientForRegion(domain.region), {
        domain: domain.name,
      });
      return c.json(
        {
          object: "domain" as const,
          ...toWire(domain),
          records: wireRecords(domain, verification, deps),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/domains/{id}/verify",
      request: { params: idParam },
      responses: {
        200: {
          content: { "application/json": { schema: getDomainResponseSchema } },
          description: "Verification result: the domain with per-record status",
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const domain = await findDomain(auth.teamId, c.req.valid("param").id);
      if (!domain) return c.json(errorBody(404, "not_found", "Domain not found"), 404);
      // The shared source of truth the dashboard verify and the worker cron
      // also run: SES status + live DNS folded into the strict stored status
      // the send gate keys off.
      const resolver = ses.dns ?? nodeDnsResolver;
      const result = await computeDomainVerification(
        ses.clientForRegion(domain.region),
        resolver,
        domain,
      );
      const { status, verification } = result;
      // The branded tracking CNAME never gates status, so computeDomainVerification
      // omits it. Seeing it resolve clears the 72h clock here, which is what lets
      // the worker serve links through it without waiting for the reverify sweep.
      const cnameFound =
        domain.trackingSubdomain &&
        domain.trackingSubdomainSetAt &&
        deps.appBaseUrl &&
        deps.trackingSubdomains !== false
          ? (
              await checkDnsRecords(
                [
                  {
                    type: "CNAME",
                    name: `${domain.trackingSubdomain}.${domain.name}`,
                    value: trackingCnameTarget(deps.appBaseUrl),
                  },
                ],
                resolver,
              )
            )[0] === "found"
          : false;
      const now = new Date();
      await db
        .update(d)
        .set({
          status,
          lastCheckedAt: now,
          ...verificationDbPatch(result, now),
          ...(status === "verified" && !domain.verifiedAt ? { verifiedAt: now } : {}),
        })
        .where(and(eq(d.id, domain.id), eq(d.teamId, auth.teamId)));
      // Scoped to the label that was checked: a subdomain changed while the DNS
      // lookups ran has its own fresh clock, which this pass must not clear.
      const trackingResolved =
        cnameFound &&
        (
          await db
            .update(d)
            .set({ trackingSubdomainSetAt: null })
            .where(
              and(
                eq(d.id, domain.id),
                eq(d.teamId, auth.teamId),
                eq(d.trackingSubdomain, domain.trackingSubdomain ?? ""),
              ),
            )
            .returning({ id: d.id })
        ).length > 0;
      if (status === "verified" && domain.status !== "verified") {
        await recordAudit(db, {
          teamId: auth.teamId,
          actor: apiRequestActor(auth),
          action: "domain.verified",
          target: { type: "domain", id: domain.id },
          metadata: { name: domain.name },
        });
      }
      // Full object with per-record status — the promised "fresh status"
      // without a get_domain round-trip. Additive over the SDK's { id }.
      const fresh = {
        ...domain,
        status,
        verifiedAt: status === "verified" && !domain.verifiedAt ? now : domain.verifiedAt,
        ...(trackingResolved ? { trackingSubdomainSetAt: null } : {}),
      };
      return c.json(
        {
          object: "domain" as const,
          ...toWire(fresh),
          records: wireRecords(fresh, verification, deps),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/domains/{id}",
      request: {
        params: idParam,
        body: { content: { "application/json": { schema: updateDomainRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: getDomainResponseSchema } },
          description: "Domain updated; full object with records",
        },
        404: jsonErr("Not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const body = c.req.valid("json");
      if (body.tls !== undefined) {
        return c.json(errorBody(422, "validation_error", "tls is not supported"), 422);
      }
      if (body.capabilities !== undefined) {
        return c.json(errorBody(422, "validation_error", "capabilities is not supported"), 422);
      }
      const domain = await findDomain(auth.teamId, c.req.valid("param").id);
      if (!domain) return c.json(errorBody(404, "not_found", "Domain not found"), 404);

      const trackingError = trackingSettingsError(
        deps,
        {
          open: body.open_tracking,
          click: body.click_tracking,
          subdomain: body.tracking_subdomain,
        },
        {
          open: domain.openTracking,
          click: domain.clickTracking,
          subdomain: domain.trackingSubdomain,
          mailFromSubdomain: domain.mailFromSubdomain,
        },
      );
      if (trackingError) {
        return c.json(errorBody(422, "validation_error", trackingError), 422);
      }

      const set: Partial<
        Pick<
          typeof schema.domains.$inferInsert,
          "openTracking" | "clickTracking" | "trackingSubdomain" | "trackingSubdomainSetAt"
        >
      > = {};
      if (body.open_tracking !== undefined) set.openTracking = body.open_tracking;
      if (body.click_tracking !== undefined) set.clickTracking = body.click_tracking;
      if (body.tracking_subdomain !== undefined) {
        const nextSubdomain = body.tracking_subdomain || null;
        set.trackingSubdomain = nextSubdomain;
        // Same 72h auto-unset clock as the dashboard: arm on adopt/change,
        // clear on removal, leave a re-save of the same value alone.
        if (nextSubdomain === null) {
          set.trackingSubdomainSetAt = null;
        } else if (nextSubdomain !== domain.trackingSubdomain) {
          set.trackingSubdomainSetAt = new Date();
        }
      }
      if (Object.keys(set).length > 0) {
        await db
          .update(d)
          .set(set)
          .where(and(eq(d.id, domain.id), eq(d.teamId, auth.teamId)));
      }
      // Full object so the caller sees the settings it just changed —
      // additive over the SDK's { id }. Records come from SES's cached
      // verification, same as GET.
      const updated = {
        ...domain,
        openTracking: set.openTracking ?? domain.openTracking,
        clickTracking: set.clickTracking ?? domain.clickTracking,
        trackingSubdomain:
          set.trackingSubdomain !== undefined ? set.trackingSubdomain : domain.trackingSubdomain,
        trackingSubdomainSetAt:
          set.trackingSubdomainSetAt !== undefined
            ? set.trackingSubdomainSetAt
            : domain.trackingSubdomainSetAt,
      };
      const verification = await getDomainVerification(ses.clientForRegion(domain.region), {
        domain: domain.name,
      });
      return c.json(
        {
          object: "domain" as const,
          ...toWire(updated),
          records: wireRecords(updated, verification, deps),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/domains/{id}",
      request: { params: idParam },
      responses: {
        200: {
          content: { "application/json": { schema: removeDomainResponseSchema } },
          description: "Domain deleted",
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const domain = await findDomain(auth.teamId, c.req.valid("param").id);
      if (!domain) return c.json(errorBody(404, "not_found", "Domain not found"), 404);
      // The SES identity is shared by every row with the same (name, region):
      // it goes only with the last of them.
      if (!(await isIdentitySharedByOtherDomains(db, domain))) {
        try {
          if (domain.sesTenantAssociatedAt) {
            await disassociateIdentity(ses.clientForRegion(domain.region), {
              tenantName: domain.teamId,
              region: domain.region,
              identity: domain.name,
            });
          }
          await deleteDomainIdentity(ses.clientForRegion(domain.region), { domain: domain.name });
        } catch (error) {
          // An identity already gone from SES must not block removing the row.
          if ((error as { name?: string }).name !== "NotFoundException") throw error;
        }
      }
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await failQueuedEmailsForDomain(txDb, { teamId: auth.teamId, domainId: domain.id });
        // api_keys.domainId is ON DELETE restrict (a scoped key must never
        // silently widen to all domains): revoke every scoped key and drop its
        // FK first — a revoked key never authenticates, and clearing domainId
        // frees the delete. Same guards as the dashboard delete.
        await txDb
          .update(schema.apiKeys)
          .set({ revokedAt: new Date(), domainId: null })
          .where(
            and(eq(schema.apiKeys.teamId, auth.teamId), eq(schema.apiKeys.domainId, domain.id)),
          );
        await txDb.delete(d).where(and(eq(d.id, domain.id), eq(d.teamId, auth.teamId)));
      });
      await recordAudit(db, {
        teamId: auth.teamId,
        actor: apiRequestActor(auth),
        action: "domain.deleted",
        target: { type: "domain", id: domain.id },
        metadata: { name: domain.name },
      });
      return c.json({ object: "domain" as const, id: domain.id, deleted: true as const }, 200);
    },
  );
}
