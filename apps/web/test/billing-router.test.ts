import type { BillingStripe } from "@millionsend/billing";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamRole } from "@/server/membership";
import { createBillingRouter } from "@/server/routers/billing";
import { createCallerFactory, router } from "@/server/trpc";

let db: Db;
let close: () => Promise<void>;
let calls: {
  customers: Stripe.CustomerCreateParams[];
  checkouts: Stripe.Checkout.SessionCreateParams[];
  portals: Stripe.BillingPortal.SessionCreateParams[];
};

const stripe = {
  prices: {
    list: async () => ({
      data: [
        { id: "price_pro", lookup_key: "millionsend_pro_monthly" },
        { id: "price_scale", lookup_key: "millionsend_scale_monthly" },
      ],
    }),
  },
  customers: {
    create: async (params: Stripe.CustomerCreateParams) => {
      calls.customers.push(params);
      return { id: "cus_new" };
    },
  },
  checkout: {
    sessions: {
      create: async (params: Stripe.Checkout.SessionCreateParams) => {
        calls.checkouts.push(params);
        return { url: "https://checkout.stripe.com/c/cs_1" };
      },
    },
  },
  billingPortal: {
    sessions: {
      create: async (params: Stripe.BillingPortal.SessionCreateParams) => {
        calls.portals.push(params);
        return { url: "https://billing.stripe.com/p/1" };
      },
    },
  },
} as unknown as BillingStripe;

const createCaller = createCallerFactory(
  router({ billing: createBillingRouter({ stripe: () => stripe }) }),
);

function callerFor(teamId: string, role: TeamRole) {
  return createCaller({
    db,
    session: { user: { id: "u1", email: "u1@example.com", name: "u1" } },
    teamId,
    role,
  });
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  calls = { customers: [], checkouts: [], portals: [] };
  vi.stubEnv("IS_CLOUD", "true");
  vi.stubEnv("APP_BASE_URL", "https://app.example.com");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

describe("billing router", () => {
  it("does not exist on self-host", async () => {
    vi.stubEnv("IS_CLOUD", "");
    const teamId = await createTeam(db);
    const owner = callerFor(teamId, "owner");
    await expect(owner.billing.status()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(owner.billing.checkout({ plan: "pro" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(owner.billing.portal()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls.checkouts).toEqual([]);
  });

  it("status reports the entitlement to any member", async () => {
    const teamId = await createTeam(db);
    expect(await callerFor(teamId, "member").billing.status()).toEqual({
      plan: "free",
      planStatus: "none",
      currentPeriodEnd: null,
      dailyLimit: 100,
      hasCustomer: false,
    });
  });

  it("checkout and portal are owner/admin only", async () => {
    const teamId = await createTeam(db);
    const member = callerFor(teamId, "member");
    await expect(member.billing.checkout({ plan: "pro" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(member.billing.portal()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("checkout creates the customer once, stores it, and returns the session url", async () => {
    const teamId = await createTeam(db, "acme");
    const admin = callerFor(teamId, "admin");
    expect(await admin.billing.checkout({ plan: "scale" })).toEqual({
      url: "https://checkout.stripe.com/c/cs_1",
    });
    expect(calls.customers).toEqual([
      { name: "acme", email: "u1@example.com", metadata: { team_id: teamId } },
    ]);
    expect(calls.checkouts[0]).toMatchObject({
      mode: "subscription",
      customer: "cus_new",
      client_reference_id: teamId,
      line_items: [{ price: "price_scale", quantity: 1 }],
      success_url: "https://app.example.com/settings/billing?checkout=success",
      cancel_url: "https://app.example.com/settings/billing",
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      allow_promotion_codes: true,
      billing_address_collection: "auto",
    });
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(team).toMatchObject({ stripeCustomerId: "cus_new", plan: "free", planStatus: "none" });

    await admin.billing.checkout({ plan: "pro" });
    expect(calls.customers).toHaveLength(1);
    expect(calls.checkouts[1]).toMatchObject({
      customer: "cus_new",
      line_items: [{ price: "price_pro", quantity: 1 }],
    });
  });

  it("portal needs a customer and passes the configured portal id", async () => {
    const teamId = await createTeam(db);
    const owner = callerFor(teamId, "owner");
    await expect(owner.billing.portal()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    await db
      .update(schema.teams)
      .set({ stripeCustomerId: "cus_1" })
      .where(eq(schema.teams.id, teamId));
    expect(await owner.billing.portal()).toEqual({ url: "https://billing.stripe.com/p/1" });
    expect(calls.portals).toEqual([
      { customer: "cus_1", return_url: "https://app.example.com/settings/billing" },
    ]);

    vi.stubEnv("STRIPE_PORTAL_CONFIG", "bpc_1");
    await owner.billing.portal();
    expect(calls.portals[1]).toMatchObject({ configuration: "bpc_1" });
  });
});
