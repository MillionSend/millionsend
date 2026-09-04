import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eraseRecipient } from "../src/erase-recipient.js";
import { hashRecipient } from "../src/suppressions.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let otherTeamId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "erase-team");
  otherTeamId = await createTeam(db, "other-team");
});
afterAll(() => close());

const ADDRESS = "bob@example.com";

async function seedEmail(team: string, to: string[], cc?: string[]): Promise<string> {
  const [row] = await db
    .insert(schema.emails)
    .values({ teamId: team, from: "a@acme.dev", to, cc: cc ?? null, subject: "s" })
    .returning({ id: schema.emails.id });
  if (!row) throw new Error("insert failed");
  return row.id;
}

it("tombstones every copy of the address for the team, keeps the suppression hash, and is idempotent", async () => {
  const emailId = await seedEmail(
    teamId,
    [`Bob <${ADDRESS}>`, "keep@example.com"],
    ["BOB@Example.com"],
  );
  const untouched = await seedEmail(teamId, ["keep@example.com"]);
  const foreign = await seedEmail(otherTeamId, [ADDRESS]);
  await db.insert(schema.emailEvents).values({
    emailId,
    type: "bounced",
    occurredAt: new Date(),
    data: {
      eventType: "Bounce",
      bounce: {
        bounceType: "Permanent",
        bouncedRecipients: [{ emailAddress: ADDRESS, diagnosticCode: `550 <${ADDRESS}> no` }],
      },
    },
  });
  const [endpoint] = await db
    .insert(schema.webhookEndpoints)
    .values({
      teamId,
      url: "https://hooks.example.com",
      secretCiphertext: Buffer.from("c"),
      secretIv: Buffer.from("i"),
      secretWrappedDek: Buffer.from("d"),
      secretKeyVersion: 1,
      secretLast4: "abcd",
    })
    .returning({ id: schema.webhookEndpoints.id });
  if (!endpoint) throw new Error("insert failed");
  const [delivery] = await db
    .insert(schema.webhookDeliveries)
    .values({
      endpointId: endpoint.id,
      emailId: null,
      messageId: "msg_1",
      eventType: "email.bounced",
      payload: { type: "email.bounced", data: { to: [ADDRESS], subject: "s" } },
      lastResponseBody: `stored ${ADDRESS} ok`,
    })
    .returning({ id: schema.webhookDeliveries.id });
  if (!delivery) throw new Error("insert failed");
  await db.insert(schema.suppressions).values([
    { teamId, email: ADDRESS, emailHash: hashRecipient(ADDRESS), reason: "hard_bounce" },
    {
      teamId,
      email: "keep@example.com",
      emailHash: hashRecipient("keep@example.com"),
      reason: "manual",
    },
  ]);
  await db.insert(schema.apiRequests).values([
    { teamId, method: "DELETE", path: `/contacts/${ADDRESS}`, statusCode: 200 },
    { teamId, method: "POST", path: "/emails", statusCode: 200, requestBody: { to: [ADDRESS] } },
    {
      teamId,
      method: "GET",
      path: "/emails",
      statusCode: 200,
      responseBody: { to: ["keep@example.com"] },
    },
  ]);

  const result = await eraseRecipient(db, teamId, ` ${ADDRESS.toUpperCase()} `);
  expect(result).toEqual({ emails: 1, events: 1, deliveries: 1, apiRequests: 2, suppressions: 1 });

  const [email] = await db.select().from(schema.emails).where(eq(schema.emails.id, emailId));
  expect(email?.to).toEqual(["[erased]", "keep@example.com"]);
  expect(email?.cc).toEqual(["[erased]"]);
  expect(email?.bcc).toBeNull();
  const [event] = await db
    .select()
    .from(schema.emailEvents)
    .where(eq(schema.emailEvents.emailId, emailId));
  expect(event?.data).toEqual({
    eventType: "Bounce",
    bounce: {
      bounceType: "Permanent",
      bouncedRecipients: [{ emailAddress: "[erased]", diagnosticCode: "[erased]" }],
    },
  });
  const [d] = await db
    .select()
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.id, delivery.id));
  expect(d?.payload).toEqual({ type: "email.bounced", data: { to: ["[erased]"], subject: "s" } });
  expect(d?.lastResponseBody).toBe("stored [erased] ok");
  const suppressions = await db
    .select({ email: schema.suppressions.email, emailHash: schema.suppressions.emailHash })
    .from(schema.suppressions)
    .where(eq(schema.suppressions.teamId, teamId));
  expect(suppressions).toEqual(
    expect.arrayContaining([
      { email: null, emailHash: hashRecipient(ADDRESS) },
      { email: "keep@example.com", emailHash: hashRecipient("keep@example.com") },
    ]),
  );
  const requests = await db.select({ path: schema.apiRequests.path }).from(schema.apiRequests);
  expect(requests).toEqual([{ path: "/emails" }]);

  const [keep] = await db.select().from(schema.emails).where(eq(schema.emails.id, untouched));
  expect(keep?.to).toEqual(["keep@example.com"]);
  const [foreignRow] = await db.select().from(schema.emails).where(eq(schema.emails.id, foreign));
  expect(foreignRow?.to).toEqual([ADDRESS]);

  expect(await eraseRecipient(db, teamId, ADDRESS)).toEqual({
    emails: 0,
    events: 0,
    deliveries: 0,
    apiRequests: 0,
    suppressions: 0,
  });
});

it("drops the contact's name from contact event payloads along with the address", async () => {
  const address = "carla@example.com";
  const [endpoint] = await db
    .insert(schema.webhookEndpoints)
    .values({
      teamId,
      url: "https://example.com/hooks/erase",
      secretCiphertext: Buffer.alloc(1),
      secretIv: Buffer.alloc(1),
      secretWrappedDek: Buffer.alloc(1),
      secretKeyVersion: 1,
      secretLast4: "abcd",
    })
    .returning({ id: schema.webhookEndpoints.id });
  if (!endpoint) throw new Error("endpoint insert failed");
  const [delivery] = await db
    .insert(schema.webhookDeliveries)
    .values({
      endpointId: endpoint.id,
      messageId: "msg_erase_contact",
      eventType: "contact.created",
      payload: {
        type: "contact.created",
        data: { id: "c1", email: address, first_name: "Carla", last_name: "Souza", source: "api" },
      },
    })
    .returning({ id: schema.webhookDeliveries.id });
  if (!delivery) throw new Error("delivery insert failed");

  await eraseRecipient(db, teamId, address);

  const [after] = await db
    .select({ payload: schema.webhookDeliveries.payload })
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.id, delivery.id));
  expect(after?.payload).toEqual({
    type: "contact.created",
    data: { id: "c1", email: "[erased]", source: "api" },
  });
});
