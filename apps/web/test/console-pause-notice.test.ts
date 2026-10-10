import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createCaller } from "@/server/routers";

const mail = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock("@/server/system-mail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/system-mail")>();
  return { ...actual, sendAccountMail: (m: { to: string }) => void mail.sent.push(m.to) };
});
vi.mock("@/server/queue", () => ({ getQueue: async () => ({ runCronNow: async () => {} }) }));

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  // The first registered user is the operator.
  await db.insert(schema.user).values([
    { id: "op", name: "Operator", email: "op@example.com", createdAt: new Date(0) },
    { id: "owner", name: "Owner", email: "owner@example.com", createdAt: new Date(1) },
  ]);
});
afterAll(() => close());
afterEach(() => vi.unstubAllEnvs());

const teams = () =>
  createCaller({
    db,
    session: {
      user: { id: "op", email: "op@example.com", name: "op" },
      session: { id: "s-op", createdAt: new Date() },
    },
    teamId: null,
    role: null,
  }).console.teams;

it("an operator's broadcast pause emails an active team's owner, never a suspended team's", async () => {
  vi.stubEnv("AUTH_EMAIL_FROM", "MillionSend <account@example.com>");
  const id = await createTeam(db, "held");
  await db.insert(schema.teamMembers).values({ teamId: id, userId: "owner", role: "owner" });

  await teams().pauseBroadcasts({ id, reason: "report", notify: true });
  expect(mail.sent).toEqual(["owner@example.com"]);
  await teams().resumeBroadcasts({ id });

  mail.sent = [];
  await db
    .update(schema.teams)
    .set({ suspendedAt: new Date(), suspensionReason: "phishing" })
    .where(eq(schema.teams.id, id));
  await teams().pauseBroadcasts({ id, reason: "report", notify: true });
  await teams().resumeBroadcasts({ id });
  await teams().adjustLimits({ id, dailySendCeiling: null, broadcastsPaused: true });
  expect(mail.sent).toEqual([]);
  const pauses = await db
    .select({ data: schema.auditLog.data })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, "team.broadcasts_paused"));
  // The suspended pause is recorded as not notified, whatever the operator ticked.
  expect(pauses.filter((p) => p.data?.notified === false)).toHaveLength(1);
});
