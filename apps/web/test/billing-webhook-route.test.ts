import { formatMailDate, type SystemMailMessage } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  db: undefined as unknown as Db,
  runCronNow: vi.fn(async (_name: string) => {}),
  // Stands in for Stripe's subscription handling: the route only needs to see
  // the team's billing columns change under a verified event.
  afterEvent: null as Partial<typeof schema.teams.$inferInsert> | null,
  sent: [] as SystemMailMessage[],
}));

vi.mock("@millionsend/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@millionsend/db")>();
  return { ...actual, getDb: () => h.db };
});
vi.mock("@/server/queue", () => ({ getQueue: async () => ({ runCronNow: h.runCronNow }) }));
vi.mock("@/server/system-mail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/system-mail")>();
  return { ...actual, sendAccountMail: (m: SystemMailMessage) => void h.sent.push(m) };
});
vi.mock("@millionsend/billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@millionsend/billing")>();
  return {
    ...actual,
    handleWebhook: async (...args: Parameters<typeof actual.handleWebhook>) => {
      if (!h.afterEvent) return actual.handleWebhook(...args);
      await h.db
        .update(schema.teams)
        .set(h.afterEvent)
        .where(eq(schema.teams.stripeCustomerId, "cus_1"));
      return 200;
    },
  };
});

const { POST } = await import("@/app/api/billing/webhook/route");

const SECRET = "whsec_test";
const { webhooks } = new Stripe("sk_test_x");
const payload = JSON.stringify({
  id: "evt_1",
  object: "event",
  type: "customer.created",
  livemode: false,
  data: { object: { id: "cus_1" } },
});

function post(signature: string | null): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature) headers.set("stripe-signature", signature);
  return POST(
    new Request("https://app.example.com/api/billing/webhook", {
      method: "POST",
      headers,
      body: payload,
    }),
  );
}

/** A signed event for customer cus_1; `object` is merged into Stripe's data.object. */
function send(id: string, type: string, object: Record<string, unknown> = {}): Promise<Response> {
  const body = JSON.stringify({
    id,
    object: "event",
    type,
    livemode: false,
    data: { object: { id: "sub_1", customer: "cus_1", ...object } },
  });
  return POST(
    new Request("https://app.example.com/api/billing/webhook", {
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        "stripe-signature": webhooks.generateTestHeaderString({ payload: body, secret: SECRET }),
      }),
      body,
    }),
  );
}

async function subscribedTeam(name = "upgrader"): Promise<string> {
  const teamId = await createTeam(h.db, name);
  await h.db
    .update(schema.teams)
    .set({ stripeCustomerId: "cus_1" })
    .where(eq(schema.teams.id, teamId));
  return teamId;
}

async function addOwner(teamId: string, id: string, email: string) {
  await h.db.insert(schema.user).values({ id, name: id, email });
  await h.db.insert(schema.teamMembers).values({ teamId, userId: id, role: "owner" });
}

let close: () => Promise<void>;

beforeEach(async () => {
  ({ db: h.db, close } = await createTestDb());
  vi.stubEnv("IS_CLOUD", "true");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("APP_BASE_URL", "https://app.example.com");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  h.afterEvent = null;
  h.sent = [];
  h.runCronNow.mockClear();
  await close();
});

describe("POST /api/billing/webhook", () => {
  it("is not mounted on self-host", async () => {
    vi.stubEnv("IS_CLOUD", "");
    const valid = webhooks.generateTestHeaderString({ payload, secret: SECRET });
    expect((await post(valid)).status).toBe(404);
    expect(await h.db.select().from(schema.stripeEvents)).toEqual([]);
  });

  it("rejects unsigned and mis-signed bodies", async () => {
    expect((await post(null)).status).toBe(400);
    expect(
      (await post(webhooks.generateTestHeaderString({ payload, secret: "whsec_other" }))).status,
    ).toBe(400);
    expect(await h.db.select().from(schema.stripeEvents)).toEqual([]);
  });

  it("drains quota-parked mail at once when an event raises the team's quota", async () => {
    await subscribedTeam();
    h.afterEvent = { plan: "pro" };
    expect((await send("evt_up", "customer.subscription.updated")).status).toBe(200);
    expect(h.runCronNow).toHaveBeenCalledWith("quota.drain");

    // A higher rung of the same plan is a raise too.
    h.runCronNow.mockClear();
    h.afterEvent = { planQuota: 200_000 };
    expect((await send("evt_rung", "customer.subscription.updated")).status).toBe(200);
    expect(h.runCronNow).toHaveBeenCalledWith("quota.drain");

    // A queue hiccup never fails the webhook: the plan is committed and the
    // scheduled drain releases the mail anyway.
    h.runCronNow.mockClear();
    h.runCronNow.mockRejectedValueOnce(new Error("pg-boss unavailable"));
    h.afterEvent = { plan: "scale" };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await send("evt_up2", "customer.subscription.updated")).status).toBe(200);
    expect(h.runCronNow).toHaveBeenCalledTimes(1);
    errors.mockRestore();

    // A downgrade leaves the schedule alone.
    h.runCronNow.mockClear();
    h.afterEvent = { plan: "free" };
    expect((await send("evt_down", "customer.subscription.updated")).status).toBe(200);
    expect(h.runCronNow).not.toHaveBeenCalled();
  });

  it("acknowledges a verified event and records it", async () => {
    const valid = webhooks.generateTestHeaderString({ payload, secret: SECRET });
    expect((await post(valid)).status).toBe(200);
    expect((await post(valid)).status).toBe(200);
    expect(await h.db.select({ id: schema.stripeEvents.id }).from(schema.stripeEvents)).toEqual([
      { id: "evt_1" },
    ]);
  });
});

describe("owner mail", () => {
  const PERIOD_END = new Date("2026-09-30T12:00:00Z");
  let teamId: string;

  beforeEach(async () => {
    vi.stubEnv("AUTH_EMAIL_FROM", "MillionSend <account@mail.example.com>");
    teamId = await subscribedTeam();
    await addOwner(teamId, "ada", "ada@example.com");
    // A plain member hears nothing about billing.
    await h.db.insert(schema.user).values({ id: "cid", name: "cid", email: "cid@example.com" });
    await h.db.insert(schema.teamMembers).values({ teamId, userId: "cid", role: "member" });
  });

  const kinds = () => h.sent.map((m) => m.kind);

  it("says nothing without an account sender", async () => {
    vi.stubEnv("AUTH_EMAIL_FROM", "");
    h.afterEvent = { plan: "pro" };
    await send("evt_1", "customer.subscription.updated");
    expect(h.sent).toEqual([]);
  });

  it("reports an activation once, however often and however parallel Stripe delivers the events", async () => {
    vi.stubEnv("NOTIFICATIONS_EMAIL_FROM", "MillionSend <notices@mail.example.com>");
    h.afterEvent = { plan: "pro", currentPeriodEnd: PERIOD_END };
    // A checkout's three events arrive together; each request snapshots the
    // free plan before any of them is applied.
    await Promise.all([
      send("evt_1", "checkout.session.completed", { id: "cs_1" }),
      send("evt_2", "customer.subscription.created"),
      send("evt_3", "invoice.paid", { id: "in_1" }),
    ]);
    await send("evt_2", "customer.subscription.created");
    expect(kinds()).toEqual(["billing.plan_activated"]);
    expect(h.sent[0]).toMatchObject({
      from: "MillionSend <notices@mail.example.com>",
      to: "ada@example.com",
      subject: "upgrader is on Pro 100K",
    });
    expect(h.sent[0]?.text).toContain("up to 100,000 emails a month");
    expect(h.sent[0]?.text).toContain("https://app.example.com/settings/billing");
  });

  it("reports a move between paid plans, or between rungs of one, with the new cap", async () => {
    h.afterEvent = { plan: "pro", planQuota: 100_000, currentPeriodEnd: PERIOD_END };
    await send("evt_1", "customer.subscription.updated");
    h.afterEvent = { plan: "scale", planQuota: 500_000 };
    await send("evt_2", "customer.subscription.updated");
    expect(kinds()).toEqual(["billing.plan_activated", "billing.plan_changed"]);
    expect(h.sent[1]?.subject).toBe("upgrader moved from Pro 100K to Scale 500K");
    expect(h.sent[1]?.text).toContain("up to 500,000 emails a month");

    // The plan column stays; only the bought volume moved.
    h.afterEvent = { planQuota: 1_000_000 };
    await send("evt_3", "customer.subscription.updated");
    await send("evt_3", "customer.subscription.updated");
    expect(kinds()).toHaveLength(3);
    expect(h.sent[2]?.subject).toBe("upgrader moved from Scale 500K to Scale 1M");
    expect(h.sent[2]?.text).toContain("up to 1,000,000 emails a month");
  });

  it("reports a failed charge once per attempt, with Stripe's next try or the lack of one", async () => {
    await h.db.update(schema.teams).set({ plan: "pro" }).where(eq(schema.teams.id, teamId));
    const failed = (id: string, attempt: number, next: number | null) =>
      send(id, "invoice.payment_failed", {
        id: "in_1",
        attempt_count: attempt,
        next_payment_attempt: next,
        hosted_invoice_url: "https://invoice.stripe.com/i/in_1",
      });
    h.afterEvent = { planStatus: "past_due" };
    await failed("evt_1", 1, Date.UTC(2026, 9, 3) / 1000);
    await failed("evt_1", 1, Date.UTC(2026, 9, 3) / 1000);
    expect(kinds()).toEqual(["billing.payment_failed"]);
    expect(h.sent[0]?.subject).toBe("Payment failed for upgrader's Pro 100K plan");
    expect(h.sent[0]?.text).toContain("keeps sending up to 100,000 emails a month");
    expect(h.sent[0]?.text).toContain("Stripe retries on October 3, 2026.");
    expect(h.sent[0]?.text).toContain("Pay the invoice: https://invoice.stripe.com/i/in_1");
    expect(h.sent[0]?.text).toContain("https://app.example.com/settings/billing");

    await failed("evt_2", 2, null);
    expect(kinds()).toEqual(["billing.payment_failed", "billing.payment_failed"]);
    expect(h.sent[1]?.text).toContain("Stripe is not retrying on its own.");

    // A first checkout that fails never had a plan to lose: no receipt.
    await h.db
      .update(schema.teams)
      .set({ plan: "free", planStatus: "incomplete" })
      .where(eq(schema.teams.id, teamId));
    h.afterEvent = { planStatus: "incomplete" };
    await send("evt_3", "invoice.payment_failed", { id: "in_2", attempt_count: 1 });
    expect(kinds()).toHaveLength(2);
  });

  it("reports a scheduled cancellation once, and an immediate one as the downgrade only", async () => {
    await h.db
      .update(schema.teams)
      .set({ plan: "pro", currentPeriodEnd: PERIOD_END })
      .where(eq(schema.teams.id, teamId));
    h.afterEvent = { cancelAt: PERIOD_END };
    await send("evt_1", "customer.subscription.updated");
    await send("evt_2", "customer.subscription.updated");
    expect(kinds()).toEqual(["billing.cancel_scheduled"]);
    expect(h.sent[0]?.subject).toBe("Your Pro 100K plan ends on September 30, 2026");
    expect(h.sent[0]?.text).toContain("Free (100 emails a day)");

    // Resuming is the customer's own doing: nothing to tell them, and the
    // same date scheduled again later is news again.
    h.afterEvent = { cancelAt: null };
    await send("evt_3", "customer.subscription.updated");
    expect(kinds()).toHaveLength(1);
    h.afterEvent = { cancelAt: PERIOD_END };
    await send("evt_3b", "customer.subscription.updated");
    expect(kinds()).toEqual(["billing.cancel_scheduled", "billing.cancel_scheduled"]);
    h.afterEvent = { cancelAt: null };
    await send("evt_3c", "customer.subscription.updated");

    // Cancelled now: the plan ended today, not at the period end it never reached.
    h.afterEvent = { plan: "free", planStatus: "canceled", cancelAt: PERIOD_END };
    await send("evt_4", "customer.subscription.deleted");
    expect(kinds()).toEqual([
      "billing.cancel_scheduled",
      "billing.cancel_scheduled",
      "billing.downgraded",
    ]);
    expect(h.sent[2]?.subject).toBe("upgrader is now on Free");
    expect(h.sent[2]?.text).toContain(
      `The Pro 100K plan ended on ${formatMailDate("en", new Date())}.`,
    );
  });

  it("a cancellation scheduled inside the reminder window is its own reminder", async () => {
    await h.db.update(schema.teams).set({ plan: "pro" }).where(eq(schema.teams.id, teamId));
    const soon = new Date(Date.now() + 2 * 86_400_000);
    h.afterEvent = { cancelAt: soon };
    await send("evt_1", "customer.subscription.updated");
    expect(kinds()).toEqual(["billing.cancel_scheduled"]);
    expect(
      (
        await h.db
          .select({ kind: schema.teamNotifications.kind, key: schema.teamNotifications.periodKey })
          .from(schema.teamNotifications)
      ).sort((a, b) => a.kind.localeCompare(b.kind)),
    ).toEqual([
      { kind: "billing.cancel_reminder", key: soon.toISOString() },
      { kind: "billing.cancel_scheduled", key: soon.toISOString() },
    ]);
  });

  it("claims a downgrade by the period that ended, so the sweep's own report stays silent", async () => {
    await h.db
      .update(schema.teams)
      .set({ plan: "scale", currentPeriodEnd: PERIOD_END })
      .where(eq(schema.teams.id, teamId));
    h.afterEvent = { plan: "free", currentPeriodEnd: null };
    await send("evt_1", "customer.subscription.deleted");
    await send("evt_1", "customer.subscription.deleted");
    expect(kinds()).toEqual(["billing.downgraded"]);
    expect(
      await h.db
        .select({ kind: schema.teamNotifications.kind, key: schema.teamNotifications.periodKey })
        .from(schema.teamNotifications),
    ).toEqual([{ kind: "billing.downgraded", key: PERIOD_END.toISOString() }]);
  });

  it("writes each owner in the language of their account contact", async () => {
    await addOwner(teamId, "bia", "bia@example.com");
    const home = await createTeam(h.db, "home");
    await h.db.insert(schema.domains).values({
      teamId: home,
      name: "mail.example.com",
      region: "us-east-1",
      status: "verified",
    });
    await h.db
      .insert(schema.contacts)
      .values({ teamId: home, email: "bia@example.com", properties: { locale: "pt-BR" } });
    h.afterEvent = { plan: "pro" };
    await send("evt_1", "customer.subscription.updated");
    expect(h.sent.map((m) => [m.to, m.subject]).sort()).toEqual([
      ["ada@example.com", "upgrader is on Pro 100K"],
      ["bia@example.com", "upgrader está no plano Pro 100K"],
    ]);
    expect(h.sent.find((m) => m.to === "bia@example.com")?.text).toContain(
      "até 100.000 e-mails por mês",
    );
  });
});
