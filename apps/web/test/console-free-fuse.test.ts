import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createCaller } from "@/server/routers";

const h = vi.hoisted(() => ({ drains: 0 }));
vi.mock("@/server/system-mail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/system-mail")>();
  return { ...actual, sendAccountMail: () => {} };
});
vi.mock("@/server/queue", () => ({
  getQueue: async () => ({
    runCronNow: async () => {
      h.drains += 1;
    },
  }),
  enqueueEmailSend: async () => {},
  enqueueWebhookDeliveries: async () => {},
  enqueueRecipientErase: async () => {},
}));

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(schema.user).values([
    { id: "op", name: "Operator", email: "op@example.com", createdAt: new Date(0) },
    { id: "bob", name: "Bob", email: "bob@example.com", createdAt: new Date(1) },
  ]);
});
afterAll(() => close());

const callerFor = (id: string) =>
  createCaller({
    db,
    session: {
      user: { id, email: `${id}@example.com`, name: id },
      session: { id: `s-${id}`, createdAt: new Date() },
    },
    teamId: null,
    role: null,
  });

async function parked(teamId: string, parkReason: "fuse" | null): Promise<string> {
  const [row] = await db
    .insert(schema.emails)
    .values({
      teamId,
      from: "a@fused.example",
      to: ["r@outlook.com"],
      subject: "s",
      latestStatus: "queued_quota",
      parkReason,
    })
    .returning({ id: schema.emails.id });
  return row?.id ?? "";
}

it("shows the tripped Free fuse, and its release frees the mail it held for the drain, audited", async () => {
  const operator = callerFor("op");
  expect(await operator.console.safety.freeFuse()).toBeNull();
  await expect(operator.console.safety.releaseFreeFuse()).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });

  const team = await createTeam(db, "fused");
  const trippedAt = new Date(Date.now() - 3_600_000);
  await db
    .insert(schema.instanceSettings)
    .values({ id: 1, freeFuseTrippedAt: trippedAt, freeFuseComplaints: 4 });
  const held = await parked(team, "fuse");
  await parked(team, null);
  expect(await operator.console.safety.freeFuse()).toEqual({
    trippedAt,
    complaints: 4,
    parked: 1,
  });
  // Never on the review list, where a team's Release could take it.
  expect((await operator.console.safety.waiting({})).groups).toEqual([]);
  await expect(callerFor("bob").console.safety.releaseFreeFuse()).rejects.toMatchObject({
    code: "NOT_FOUND",
  });

  const drains = h.drains;
  expect(await operator.console.safety.releaseFreeFuse()).toEqual({ complaints: 4, emails: 1 });
  expect(h.drains).toBe(drains + 1);
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, held));
  expect(row).toMatchObject({ latestStatus: "queued_quota", parkReason: null });
  expect(await operator.console.safety.freeFuse()).toBeNull();
  const [fuse] = await db.select().from(schema.instanceSettings);
  expect(fuse?.freeFuseTrippedAt).toBeNull();
  expect(fuse?.freeFuseReleasedAt).toBeInstanceOf(Date);
  const audit = await db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, "free_fuse.released"));
  expect(audit).toMatchObject([
    { teamId: null, actorId: "user:op", data: { complaints: 4, emails: 1 } },
  ]);
});
