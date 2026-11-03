import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb, createWebhookEndpoint } from "@millionsend/test-utils";
import { count, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createFixedWindowLimiter,
  failQueuedEmailsForDomain,
  isIdentitySharedByOtherDomains,
  isOperatorTeam,
  isReservedSenderDomain,
} from "../src/domain-lifecycle.js";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

describe("isReservedSenderDomain", () => {
  it("refuses public mailbox providers and their subdomains everywhere", () => {
    expect(isReservedSenderDomain("gmail.com", { isCloud: false })).toBe(true);
    expect(isReservedSenderDomain("mail.gmail.com", { isCloud: false })).toBe(true);
    expect(isReservedSenderDomain("notgmail.com", { isCloud: false })).toBe(false);
    expect(isReservedSenderDomain("updates.example.com", { isCloud: false })).toBe(false);
  });

  it("reserves the platform and system-mail domains only in cloud", () => {
    const authEmailFrom = "MillionSend <no-reply@mail.ms-ops.dev>";
    expect(isReservedSenderDomain("millionsend.com", { isCloud: true })).toBe(true);
    expect(isReservedSenderDomain("app.millionsend.com", { isCloud: true })).toBe(true);
    expect(isReservedSenderDomain("mail.ms-ops.dev", { isCloud: true, authEmailFrom })).toBe(true);
    expect(isReservedSenderDomain("ms-ops.dev", { isCloud: true, authEmailFrom })).toBe(false);
    const onboardingEmailFrom = "onboarding@hello.ms-ops.dev";
    expect(isReservedSenderDomain("hello.ms-ops.dev", { isCloud: true, onboardingEmailFrom })).toBe(
      true,
    );
    const notificationsEmailFrom = "alerts@notify.ms-ops.dev";
    expect(
      isReservedSenderDomain("notify.ms-ops.dev", { isCloud: true, notificationsEmailFrom }),
    ).toBe(true);
    // A self-hoster's own auth domain is typically one of their team domains.
    expect(isReservedSenderDomain("mail.ms-ops.dev", { isCloud: false, authEmailFrom })).toBe(
      false,
    );
    expect(isReservedSenderDomain("millionsend.com", { isCloud: false })).toBe(false);
  });

  it("lets the operator send from the platform domain, but never a public provider", () => {
    expect(isReservedSenderDomain("mail.millionsend.com", { isCloud: true })).toBe(true);
    expect(
      isReservedSenderDomain("mail.millionsend.com", { isCloud: true, isOperator: true }),
    ).toBe(false);
    expect(isReservedSenderDomain("gmail.com", { isCloud: true, isOperator: true })).toBe(true);
  });

  it("reserves the shared inbox domain and its team subdomains for everyone, operator included", () => {
    const sharedInboxDomain = "agents.example.com";
    for (const isCloud of [true, false]) {
      for (const isOperator of [true, false]) {
        const opts = { isCloud, isOperator, sharedInboxDomain };
        expect(isReservedSenderDomain("agents.example.com", opts)).toBe(true);
        expect(isReservedSenderDomain("acme.agents.example.com", opts)).toBe(true);
        expect(isReservedSenderDomain("example.com", opts)).toBe(false);
        expect(isReservedSenderDomain("notagents.example.com", opts)).toBe(false);
      }
    }
    // Unset (the default here: SHARED_INBOX_DOMAIN is not set in tests) reserves nothing more.
    expect(isReservedSenderDomain("agents.example.com", { isCloud: true })).toBe(false);
    expect(
      isReservedSenderDomain("agents.example.com", { isCloud: true, sharedInboxDomain: null }),
    ).toBe(false);
  });
});

describe("isOperatorTeam", () => {
  it("is true only for a team the first-registered user belongs to", async () => {
    const [operator] = await db
      .insert(schema.user)
      .values({ id: "op-user", name: "Operator", email: "op@ms-ops.dev" })
      .returning({ id: schema.user.id });
    const [tenant] = await db
      .insert(schema.user)
      .values({ id: "tenant-user", name: "Tenant", email: "tenant@example.com" })
      .returning({ id: schema.user.id });
    const opTeam = await createTeam(db, "op-team");
    const tenantTeam = await createTeam(db, "tenant-team");
    await db.insert(schema.teamMembers).values([
      { teamId: opTeam, userId: operator?.id ?? "", role: "owner" },
      { teamId: tenantTeam, userId: tenant?.id ?? "", role: "owner" },
    ]);

    expect(await isOperatorTeam(db, opTeam)).toBe(true);
    expect(await isOperatorTeam(db, tenantTeam)).toBe(false);
  });
});

describe("failQueuedEmailsForDomain", () => {
  it("fails unclaimed queued rows of the domain with an event and leaves the rest alone", async () => {
    const teamId = await createTeam(db, "lifecycle-team");
    const [domain] = await db
      .insert(schema.domains)
      .values({ teamId, name: "lifecycle.example.com", region: "us-east-1", status: "verified" })
      .returning({ id: schema.domains.id });
    const [otherDomain] = await db
      .insert(schema.domains)
      .values({ teamId, name: "other.example.com", region: "us-east-1", status: "verified" })
      .returning({ id: schema.domains.id });
    if (!domain || !otherDomain) throw new Error("domain insert failed");

    const base = { teamId, from: "a@lifecycle.example.com", to: ["r@example.com"], subject: "s" };
    const [queued, parked, claimed, sent, foreign] = await db
      .insert(schema.emails)
      .values([
        { ...base, domainId: domain.id, latestStatus: "queued", scheduledAt: new Date() },
        { ...base, domainId: domain.id, latestStatus: "queued_quota" },
        { ...base, domainId: domain.id, latestStatus: "queued", sentAt: new Date() },
        { ...base, domainId: domain.id, latestStatus: "delivered", sentAt: new Date() },
        { ...base, domainId: otherDomain.id, latestStatus: "queued" },
      ])
      .returning({ id: schema.emails.id });

    const endpointId = await createWebhookEndpoint(db, teamId, ["email.failed"]);
    const collected: string[] = [];
    const enqueue = async (rows: readonly { id: string }[]) => {
      collected.push(...rows.map((r) => r.id));
    };
    expect(await failQueuedEmailsForDomain(db, { teamId, domainId: domain.id, enqueue })).toBe(2);

    const statusOf = async (id: string | undefined) =>
      (
        await db
          .select({ s: schema.emails.latestStatus })
          .from(schema.emails)
          .where(eq(schema.emails.id, id ?? ""))
      )[0]?.s;
    expect(await statusOf(queued?.id)).toBe("failed");
    expect(await statusOf(parked?.id)).toBe("failed");
    expect(await statusOf(claimed?.id)).toBe("queued");
    expect(await statusOf(sent?.id)).toBe("delivered");
    expect(await statusOf(foreign?.id)).toBe("queued");

    const events = await db
      .select({ type: schema.emailEvents.type, data: schema.emailEvents.data })
      .from(schema.emailEvents)
      .where(eq(schema.emailEvents.emailId, queued?.id ?? ""));
    expect(events).toEqual([{ type: "failed", data: { reason: "domain_deleted" } }]);

    const deliveries = await db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.endpointId, endpointId));
    expect(deliveries.map((d) => d.emailId).sort()).toEqual([queued?.id, parked?.id].sort());
    expect(deliveries[0]?.payload).toMatchObject({
      type: "email.failed",
      data: { failed: { reason: "domain_deleted" } },
    });
    expect(collected.sort()).toEqual(deliveries.map((d) => d.id).sort());
  });

  it("fails a backlog too large for one statement's bind parameters, in one call", async () => {
    // 17,000 rows at four bound values each would be 68,000 parameters, past
    // Postgres's 65,535: the old per-row event insert aborted the delete.
    const teamId = await createTeam(db, "backlog-team");
    const [domain] = await db
      .insert(schema.domains)
      .values({ teamId, name: "backlog.example.com", region: "us-east-1", status: "verified" })
      .returning({ id: schema.domains.id });
    if (!domain) throw new Error("domain insert failed");
    await createWebhookEndpoint(db, teamId, null);
    await db.execute(sql`
      insert into ${schema.emails} (team_id, domain_id, "from", "to", subject, latest_status)
      select ${teamId}::uuid, ${domain.id}::uuid, 'a@backlog.example.com',
        '["r@example.com"]'::jsonb, 's', 'queued_quota'
      from generate_series(1, 17000)
    `);
    let collected = 0;

    const failed = await db.transaction((tx) =>
      failQueuedEmailsForDomain(tx as unknown as Db, {
        teamId,
        domainId: domain.id,
        enqueue: async (rows) => {
          collected += rows.length;
        },
      }),
    );

    expect(failed).toBe(17_000);
    const [events] = await db
      .select({ n: count() })
      .from(schema.emailEvents)
      .innerJoin(schema.emails, eq(schema.emails.id, schema.emailEvents.emailId))
      .where(eq(schema.emails.teamId, teamId));
    expect(events?.n).toBe(17_000);
    expect(collected).toBe(17_000);
  }, 60_000);
});

describe("isIdentitySharedByOtherDomains", () => {
  it("is true only while another row holds the same (name, region)", async () => {
    const teamA = await createTeam(db, "shared-a");
    const teamB = await createTeam(db, "shared-b");
    const teamC = await createTeam(db, "shared-c");
    const [a] = await db
      .insert(schema.domains)
      .values({ teamId: teamA, name: "shared.example.com", region: "us-east-1" })
      .returning();
    if (!a) throw new Error("insert failed");
    expect(await isIdentitySharedByOtherDomains(db, a)).toBe(false);

    await db
      .insert(schema.domains)
      .values({ teamId: teamB, name: "shared.example.com", region: "eu-west-1" });
    expect(await isIdentitySharedByOtherDomains(db, a)).toBe(false);

    await db
      .insert(schema.domains)
      .values({ teamId: teamC, name: "shared.example.com", region: "us-east-1" });
    expect(await isIdentitySharedByOtherDomains(db, a)).toBe(true);
  });
});

describe("createFixedWindowLimiter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("trips past the limit per key with the seconds left in the window, and resets on a new one", () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 0, 1, 12, 0, 50) });
    const limited = createFixedWindowLimiter(2, 60_000);
    expect(limited("t1")).toBeNull();
    expect(limited("t1")).toBeNull();
    expect(limited("t1")).toBe(10);
    expect(limited("t2")).toBeNull();
    vi.setSystemTime(Date.UTC(2026, 0, 1, 12, 0, 59, 500));
    expect(limited("t1")).toBe(1);
    vi.setSystemTime(Date.UTC(2026, 0, 1, 12, 1, 0));
    expect(limited("t1")).toBeNull();
  });

  it("lets a call bring its own limit", () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 0, 1, 12, 30) });
    const limited = createFixedWindowLimiter(1, 3_600_000);
    expect(limited("t1", 3)).toBeNull();
    expect(limited("t1", 3)).toBeNull();
    expect(limited("t1", 3)).toBeNull();
    expect(limited("t1", 3)).toBe(1_800);
    expect(limited("t2")).toBeNull();
    expect(limited("t2")).toBe(1_800);
  });
});
