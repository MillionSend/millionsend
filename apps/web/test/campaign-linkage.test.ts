import { randomUUID } from "node:crypto";
import { recordSignup } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamRole } from "@/server/membership";
import { createCaller } from "@/server/routers";
import { createDomainsRouter } from "@/server/routers/domains";
import { type Context, createCallerFactory, router } from "@/server/trpc";

// Team creation sets the active-team cookie; no request scope in tests.
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {} }) }));
vi.mock("@/server/queue", () => ({
  getQueue: async () => ({ runCronNow: async () => {} }),
  enqueueEmailSend: async () => {},
  enqueueWebhookDeliveries: async () => {},
  enqueueRecipientErase: async () => {},
  enqueueDomainAge: async () => {},
}));

let db: Db;
let close: () => Promise<void>;
let phisher: string;

const OPERATOR = "op";

beforeEach(async () => {
  vi.stubEnv("AWS_REGION", "us-east-1");
  ({ db, close } = await createTestDb());
  await db
    .insert(schema.user)
    .values({ id: OPERATOR, name: "Operator", email: "op@example.com", createdAt: new Date(0) });
  phisher = await createTeam(db, "facture-vexto");
  await person("facture.vexto@gmail.com", "203.0.113.9", phisher);
  await db.insert(schema.domains).values({
    teamId: phisher,
    name: "vexto-cadeaux.example",
    region: "us-east-1",
    dkimSelector: "ms",
    dkimPublicKey: "key",
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

async function person(email: string, ip: string | null, teamId?: string) {
  const id = randomUUID();
  await db.insert(schema.user).values({ id, name: "Person", email });
  await recordSignup(db, { userId: id, email, ip, userAgent: "Firefox" });
  if (teamId) await db.insert(schema.teamMembers).values({ teamId, userId: id, role: "owner" });
  return id;
}

const callerFor = (userId: string, teamId: string | null = null, role: TeamRole | null = null) =>
  createCaller({
    db,
    session: {
      user: { id: userId, email: `${userId}@example.com`, name: userId },
      session: { id: `s-${userId}`, createdAt: new Date() },
    },
    teamId,
    role,
  });

const suspension = async (teamId: string) =>
  (
    await db
      .select({ reason: schema.teams.suspensionReason })
      .from(schema.teams)
      .where(eq(schema.teams.id, teamId))
  )[0]?.reason ?? null;

const fingerprints = (teamId: string) =>
  db
    .select({ kind: schema.campaignFingerprints.kind })
    .from(schema.campaignFingerprints)
    .where(eq(schema.campaignFingerprints.teamId, teamId));

describe("the console's suspension", () => {
  it("keeps the team's fingerprints when the reason is phishing, and only then", async () => {
    await callerFor(OPERATOR).console.teams.suspend({ id: phisher, reason: "manual" });
    expect(await fingerprints(phisher)).toEqual([]);
    await callerFor(OPERATOR).console.teams.suspend({ id: phisher, reason: "phishing" });
    expect((await fingerprints(phisher)).map((f) => f.kind).sort()).toEqual([
      "address",
      "ip",
      "sending_domain",
    ]);
  });
});

describe("a new team linked to a team suspended for phishing", () => {
  beforeEach(async () => {
    await callerFor(OPERATOR).console.teams.suspend({ id: phisher, reason: "phishing" });
  });

  it("is held as it is created by someone signed up from the same IP", async () => {
    const user = await person("novo@outlook.com", "203.0.113.9");
    const { teamId } = await callerFor(user).team.createTeam({ name: "Newcomer" });
    expect(await suspension(teamId)).toBe("review");
    const links = await callerFor(OPERATOR).console.accounts.links({ teamId });
    expect(links).toMatchObject([
      {
        linkedTeamId: phisher,
        linkedTeamName: "facture-vexto",
        trigger: "team",
        held: true,
        matches: [{ kind: "ip", value: "203.0.113.9", matched: "203.0.113.9" }],
      },
    ]);
  });

  it("is held when it adds a return's domain", async () => {
    const user = await person("novo@outlook.com", "198.51.100.7");
    const teamId = await createTeam(db, "newcomer");
    await db.insert(schema.teamMembers).values({ teamId, userId: user, role: "owner" });
    const client = { send: async () => ({}) };
    const domains = createCallerFactory(
      router({
        domains: createDomainsRouter({
          clientForRegion: () => client as never,
          resolveNs: async () => [],
        }),
      }),
    )({
      db,
      session: { user: { id: user, email: "novo@outlook.com", name: "Novo" } },
      teamId,
      role: "owner",
    } as Context);
    await domains.domains.create({ name: "cadeaux-vexto.example", region: "us-east-1" });
    expect(await suspension(teamId)).toBe("review");
  });
});
