import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFixedWindowLimiter,
  failQueuedEmailsForDomain,
  isIdentitySharedByOtherDomains,
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
    // A self-hoster's own auth domain is typically one of their team domains.
    expect(isReservedSenderDomain("mail.ms-ops.dev", { isCloud: false, authEmailFrom })).toBe(
      false,
    );
    expect(isReservedSenderDomain("millionsend.com", { isCloud: false })).toBe(false);
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

    expect(await failQueuedEmailsForDomain(db, { teamId, domainId: domain.id })).toBe(2);

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
  });
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
  it("trips past the limit per key and resets on a new window", () => {
    const limited = createFixedWindowLimiter(2, 60_000);
    expect(limited("t1")).toBe(false);
    expect(limited("t1")).toBe(false);
    expect(limited("t1")).toBe(true);
    expect(limited("t2")).toBe(false);
  });
});
