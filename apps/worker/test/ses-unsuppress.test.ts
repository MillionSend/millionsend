import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { SesSuppressionClient } from "@millionsend/ses";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runSesUnsuppress, SES_UNSUPPRESS_PAUSE_MS } from "../src/handlers/ses-unsuppress.js";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(() => {
  vi.restoreAllMocks();
  return close();
});

const awsError = (name: string) => Object.assign(new Error(name), { name });

/** Per region: the addresses it was asked to drop, and what it answers. */
function fakeSes(answer: (region: string, address: string) => unknown = () => ({})) {
  const calls: { region: string; address: string; name: string }[] = [];
  const clientForRegion = (region: string): SesSuppressionClient => ({
    async send(command) {
      const address = String(command.input.EmailAddress);
      calls.push({ region, address, name: command.constructor.name });
      const result = answer(region, address);
      if (result instanceof Error) throw result;
      return result;
    },
  });
  return { calls, clientForRegion };
}

async function insertEmail(teamId: string, values: Partial<typeof schema.emails.$inferInsert>) {
  const [row] = await db
    .insert(schema.emails)
    .values({ teamId, from: "sender@example.com", to: [], subject: "hi", ...values })
    .returning({ id: schema.emails.id });
  if (!row) throw new Error("insert failed");
  return row.id;
}

it("drops the address in every region, with the source email's spellings, pacing each round", async () => {
  const teamId = await createTeam(db, "acme");
  const sourceEmailId = await insertEmail(teamId, {
    to: ["Ada Lovelace <Ada@Example.com>", "other@example.com"],
    cc: ["ada@example.com"],
    bcc: ["ADA@example.com"],
  });
  const { calls, clientForRegion } = fakeSes();
  const sleep = vi.fn(async () => {});
  await runSesUnsuppress(
    db,
    { regions: ["sa-east-1", "us-east-1"], clientForRegion, sleep },
    { teamId, email: "ada@example.com", sourceEmailId },
  );
  expect(new Set(calls.map((c) => c.name))).toEqual(
    new Set(["DeleteSuppressedDestinationCommand"]),
  );
  expect(calls.map((c) => `${c.region} ${c.address}`)).toEqual([
    "sa-east-1 ada@example.com",
    "us-east-1 ada@example.com",
    "sa-east-1 Ada@Example.com",
    "us-east-1 Ada@Example.com",
    "sa-east-1 ADA@example.com",
    "us-east-1 ADA@example.com",
  ]);
  expect(sleep).toHaveBeenCalledTimes(3);
  expect(sleep).toHaveBeenCalledWith(SES_UNSUPPRESS_PAUSE_MS);
});

it("ignores another team's email as a spelling source", async () => {
  const teamId = await createTeam(db, "acme");
  const other = await createTeam(db, "other");
  const sourceEmailId = await insertEmail(other, { to: ["Ada@Example.com"] });
  const { calls, clientForRegion } = fakeSes();
  await runSesUnsuppress(
    db,
    { regions: ["sa-east-1"], clientForRegion, sleep: async () => {} },
    { teamId, email: "ada@example.com", sourceEmailId },
  );
  expect(calls.map((c) => c.address)).toEqual(["ada@example.com"]);
});

it("reads an address SES did not list as done", async () => {
  const teamId = await createTeam(db, "acme");
  const { clientForRegion } = fakeSes(() => awsError("NotFoundException"));
  await expect(
    runSesUnsuppress(
      db,
      { regions: ["sa-east-1", "us-east-1"], clientForRegion, sleep: async () => {} },
      { teamId, email: "ada@example.com", sourceEmailId: null },
    ),
  ).resolves.toBeUndefined();
});

it("logs a region the IAM policy denies once and does not retry it", async () => {
  const teamId = await createTeam(db, "acme");
  const sourceEmailId = await insertEmail(teamId, { to: ["Ada@Example.com"] });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { calls, clientForRegion } = fakeSes((region) =>
    region === "us-east-1" ? awsError("AccessDeniedException") : {},
  );
  await expect(
    runSesUnsuppress(
      db,
      { regions: ["sa-east-1", "us-east-1"], clientForRegion, sleep: async () => {} },
      { teamId, email: "ada@example.com", sourceEmailId },
    ),
  ).resolves.toBeUndefined();
  // The second spelling skips the denied region.
  expect(calls.map((c) => `${c.region} ${c.address}`)).toEqual([
    "sa-east-1 ada@example.com",
    "us-east-1 ada@example.com",
    "sa-east-1 Ada@Example.com",
  ]);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]?.[0])).toContain("ses:DeleteSuppressedDestination");
  expect(String(warn.mock.calls[0]?.[0])).not.toContain("example.com");
});

it("throws a throttling error into the queue's backoff after trying every region", async () => {
  const teamId = await createTeam(db, "acme");
  const { calls, clientForRegion } = fakeSes((region) =>
    region === "sa-east-1" ? awsError("TooManyRequestsException") : {},
  );
  await expect(
    runSesUnsuppress(
      db,
      { regions: ["sa-east-1", "us-east-1"], clientForRegion, sleep: async () => {} },
      { teamId, email: "ada@example.com", sourceEmailId: null },
    ),
  ).rejects.toMatchObject({ name: "TooManyRequestsException" });
  expect(calls.map((c) => c.region)).toEqual(["sa-east-1", "us-east-1"]);
});

it("tries the row's address as stored and normalized", async () => {
  const teamId = await createTeam(db, "acme");
  const { calls, clientForRegion } = fakeSes();
  await runSesUnsuppress(
    db,
    { regions: ["sa-east-1"], clientForRegion, sleep: async () => {} },
    { teamId, email: "Ada@Example.com", sourceEmailId: null },
  );
  expect(calls.map((c) => c.address)).toEqual(["Ada@Example.com", "ada@example.com"]);
});
