import type { Db } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as common from "../src/inboxes/inbox-common.js";
import { createInbox } from "../src/inboxes/inboxes.js";
import {
  ensureSharedSubdomain,
  RESERVED_SHARED_LABELS,
  reservedSharedName,
} from "../src/inboxes/shared-domain.js";

vi.mock("../src/inboxes/inbox-common.js", async (original) => {
  const real = await original<typeof import("../src/inboxes/inbox-common.js")>();
  return { ...real, randomAlnum: vi.fn(real.randomAlnum) };
});

const SHARED = "agents.example.test";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

describe("reservedSharedName", () => {
  it("compares usernames without case or separators", () => {
    for (const name of ["postmaster", "Post-Master", "no.reply", "noreply", "mailer_daemon"]) {
      expect(reservedSharedName(name)).toBe(true);
    }
    expect(reservedSharedName("leo")).toBe(false);
    expect(reservedSharedName("postmasters")).toBe(false);
  });

  it("reserves mail service names as labels, not as usernames", () => {
    expect(reservedSharedName("www")).toBe(false);
    expect(reservedSharedName("www", RESERVED_SHARED_LABELS)).toBe(true);
    expect(reservedSharedName("auto-discover", RESERVED_SHARED_LABELS)).toBe(true);
    expect(reservedSharedName("abuse", RESERVED_SHARED_LABELS)).toBe(true);
  });
});

describe("random names on the shared domain", () => {
  it("draws a refused random label again whole: every suffix of team-dhl853 still reads as DHL", async () => {
    vi.mocked(common.randomAlnum).mockReturnValueOnce("dhl853");
    const sub = await ensureSharedSubdomain(db, {
      teamId: await createTeam(db, "draw-label"),
      teamName: "株式会社",
      sharedInboxDomain: SHARED,
    });
    expect(sub.name).toMatch(/^team-[a-z0-9]{6}\.agents\.example\.test$/);
    expect(sub.name).not.toContain("dhl853");
  });

  it("draws a random address again when it spells a brand look-alike", async () => {
    const teamId = await createTeam(db, "draw-address");
    await ensureSharedSubdomain(db, {
      teamId,
      teamName: "Draw Address",
      sharedInboxDomain: SHARED,
    });
    vi.mocked(common.randomAlnum).mockReturnValueOnce("dhl12345");
    const created = await createInbox(
      db,
      { sharedInboxDomain: SHARED, receivingEnabled: true },
      {
        teamId,
        plan: "pro",
        isCloud: true,
        actor: { kind: "user", userId: "user-1" },
        input: {},
      },
    );
    expect(created.ok && created.inbox.email_address).toMatch(
      /^inbox-[a-z0-9]{8}@draw-address\.agents\.example\.test$/,
    );
    expect(created.ok && created.inbox.email_address).not.toContain("dhl12345");
  });
});
