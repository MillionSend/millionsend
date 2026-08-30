import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { isLoopbackUrl } from "@millionsend/core";
import { recordCheck } from "@millionsend/core/domain-status";
import { schema } from "@millionsend/db";
import {
  computeDomainVerification,
  createDomainIdentity,
  DKIM_SELECTOR,
  type DnsResolver,
  type DomainVerification,
  deleteDomainIdentity,
  dnsRecordsForDomain,
  generateDkimKeyPair,
  getDomainVerification,
  nodeDnsResolver,
  SES_REGIONS,
  type SesIdentityClient,
  type SesRegion,
} from "@millionsend/ses";
import { and, asc, desc, eq } from "drizzle-orm";
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
  /** Region used when a create omits `region`; must be one of SES_REGIONS. */
  defaultRegion?: string | undefined;
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
 * The domain's DNS checklist in the SDK's record shape. `verification` null =
 * SES not asked (create response): every row reads not_started. DMARC and the
 * tracking CNAME are never checked by SES, so they always read not_started.
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
      status: "not_started",
      value: new URL(deps.appBaseUrl).host,
    });
  }
  return records;
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

  const defaultRegion: SesRegion = (SES_REGIONS as readonly string[]).includes(
    ses.defaultRegion ?? "",
  )
    ? (ses.defaultRegion as SesRegion)
    : "us-east-1";

  const findDomain = async (teamId: string, id: string): Promise<DomainRow | undefined> =>
    (
      await db
        .select()
        .from(d)
        .where(and(eq(d.id, id), eq(d.teamId, teamId)))
    )[0];

  app.openapi(
    createRoute({
      method: "post",
      path: "/domains",
      request: {
        body: { content: { "application/json": { schema: createDomainRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: createDomainResponseSchema } },
          description: "Domain created",
        },
        409: jsonErr("Domain already added"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const body = c.req.valid("json");
      const region = body.region ?? defaultRegion;
      const [existing] = await db
        .select({ id: d.id })
        .from(d)
        .where(and(eq(d.teamId, auth.teamId), eq(d.name, body.name)));
      if (existing) return c.json(errorBody(409, "conflict", "domain already added"), 409);

      // BYODKIM: the private key lives only in this block — handed to SES,
      // then dereferenced. It must never be stored, returned, or logged.
      let dkim: ReturnType<typeof generateDkimKeyPair> | null = generateDkimKeyPair();
      const dkimPublicKey = dkim.publicKeyB64;
      await createDomainIdentity(ses.clientForRegion(region), {
        domain: body.name,
        mailFromSubdomain: body.custom_return_path,
        dkim: { selector: DKIM_SELECTOR, privateKeyB64: dkim.privateKeyB64 },
      });
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
      const { status, verification } = await computeDomainVerification(
        ses.clientForRegion(domain.region),
        ses.dns ?? nodeDnsResolver,
        domain,
      );
      const now = new Date();
      await db
        .update(d)
        .set({
          status,
          lastCheckedAt: now,
          ...(status === "verified" && !domain.verifiedAt ? { verifiedAt: now } : {}),
        })
        .where(and(eq(d.id, domain.id), eq(d.teamId, auth.teamId)));
      // Full object with per-record status — the promised "fresh status"
      // without a get_domain round-trip. Additive over the SDK's { id }.
      const fresh = {
        ...domain,
        status,
        verifiedAt: status === "verified" && !domain.verifiedAt ? now : domain.verifiedAt,
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

      // Tracking is app-layer: open pixels, rewritten links, and the branded
      // CNAME all point at APP_BASE_URL. A host recipients cannot reach makes
      // the toggle meaningless, so enabling is refused — disabling is always
      // allowed.
      const enabling =
        body.open_tracking === true ||
        body.click_tracking === true ||
        Boolean(body.tracking_subdomain);
      if (enabling && !deps.appBaseUrl) {
        return c.json(
          errorBody(
            422,
            "validation_error",
            "APP_BASE_URL is not set. Tracking URLs are served from it. Set it, restart, and try again.",
          ),
          422,
        );
      }
      if (enabling && isLoopbackUrl(deps.appBaseUrl)) {
        return c.json(
          errorBody(
            422,
            "validation_error",
            "APP_BASE_URL is a loopback address recipients cannot reach, so tracking cannot be enabled",
          ),
          422,
        );
      }
      // Clearing is always allowed; adopting one needs a deployment that can
      // terminate TLS for the customer's own hostname.
      if (body.tracking_subdomain && deps.trackingSubdomains === false) {
        return c.json(
          errorBody(
            422,
            "validation_error",
            "Branded tracking subdomains are not available on this deployment",
          ),
          422,
        );
      }

      const set: Partial<
        Pick<
          typeof schema.domains.$inferInsert,
          "openTracking" | "clickTracking" | "trackingSubdomain"
        >
      > = {};
      if (body.open_tracking !== undefined) set.openTracking = body.open_tracking;
      if (body.click_tracking !== undefined) set.clickTracking = body.click_tracking;
      if (body.tracking_subdomain !== undefined) {
        set.trackingSubdomain = body.tracking_subdomain || null;
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
      try {
        await deleteDomainIdentity(ses.clientForRegion(domain.region), { domain: domain.name });
      } catch (error) {
        // An identity already gone from SES must not block removing the row.
        if ((error as { name?: string }).name !== "NotFoundException") throw error;
      }
      // api_keys.domainId is ON DELETE restrict (a scoped key must never
      // silently widen to all domains): revoke every scoped key and drop its
      // FK first — a revoked key never authenticates, and clearing domainId
      // frees the delete. Same guards as the dashboard delete.
      await db
        .update(schema.apiKeys)
        .set({ revokedAt: new Date(), domainId: null })
        .where(and(eq(schema.apiKeys.teamId, auth.teamId), eq(schema.apiKeys.domainId, domain.id)));
      await db.delete(d).where(and(eq(d.id, domain.id), eq(d.teamId, auth.teamId)));
      return c.json({ object: "domain" as const, id: domain.id, deleted: true as const }, 200);
    },
  );
}
