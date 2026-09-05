import { deriveTrackingKey, makeClickToken, makeOpenToken } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A known 32-byte master key so the endpoints derive the same tracking key we
// sign tokens with here. Set before the route modules read env.
const KEY_B64 = "dOdpMPArQsV3KWv5I+kizDihKLus3uMLev4DODaFnOQ=";
process.env.MASTER_ENCRYPTION_KEY = KEY_B64;
const secretKey = deriveTrackingKey(Buffer.from(KEY_B64, "base64"));

// getDb() inside the route handlers must hit the per-test PGlite db.
const h = vi.hoisted(() => ({ db: undefined as unknown as Db }));
vi.mock("@millionsend/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@millionsend/db")>();
  return { ...actual, getDb: () => h.db };
});

const { GET: clickGet } = await import("@/app/t/c/[token]/route");
const { GET: openGet } = await import("@/app/t/o/[token]/route");

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  h.db = db;
});

afterEach(async () => {
  await close();
  vi.restoreAllMocks();
});

async function seedEmail(): Promise<{ emailId: string; teamId: string }> {
  const teamId = await createTeam(db);
  const [email] = await db
    .insert(schema.emails)
    .values({ teamId, from: "sender@example.com", to: ["rcpt@example.com"], subject: "Hi" })
    .returning({ id: schema.emails.id });
  return { emailId: email?.id ?? "", teamId };
}

// A phone's mail client: what a person's fetch looks like.
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

function req(token: string, headers: Record<string, string> = { "user-agent": IPHONE }) {
  return [
    new Request(`https://links.example.com/t/x/${token}`, { headers }),
    { params: Promise.resolve({ token }) },
  ] as const;
}

type EngagementType = "opened" | "clicked" | "prefetched";

async function counts(emailId: string, teamId: string, type: EngagementType) {
  const events = await db
    .select({ id: schema.emailEvents.id })
    .from(schema.emailEvents)
    .where(and(eq(schema.emailEvents.emailId, emailId), eq(schema.emailEvents.type, type)));
  const [counter] = await db
    .select()
    .from(schema.usageCounters)
    .where(eq(schema.usageCounters.teamId, teamId));
  return { events: events.length, counter: counter?.[type] ?? 0 };
}

/** Push every existing event of this type past the 60s damping window. */
async function backdateEvents(
  emailId: string,
  type: (typeof schema.emailEventTypeEnum.enumValues)[number],
  ageMs: number,
) {
  await db
    .update(schema.emailEvents)
    .set({ occurredAt: new Date(Date.now() - ageMs) })
    .where(and(eq(schema.emailEvents.emailId, emailId), eq(schema.emailEvents.type, type)));
}

describe("click endpoint /t/c", () => {
  it("records a unique click and 302s to the signed url", async () => {
    const { emailId, teamId } = await seedEmail();
    const url = "https://shop.example.com/product?id=9";
    const token = makeClickToken({ emailId, url, secretKey });

    const res = await clickGet(...req(token));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(url);
    expect(await counts(emailId, teamId, "clicked")).toEqual({ events: 1, counter: 1 });

    // The event carries the signed destination and the fetcher in Resend's
    // click shape.
    const [event] = await db
      .select({ data: schema.emailEvents.data })
      .from(schema.emailEvents)
      .where(and(eq(schema.emailEvents.emailId, emailId), eq(schema.emailEvents.type, "clicked")));
    expect(event?.data).toMatchObject({
      click: { link: url, userAgent: IPHONE, timestamp: expect.stringMatching(/Z$/) },
    });

    // A second click within the damping window is dropped entirely.
    const res2 = await clickGet(...req(token));
    expect(res2.status).toBe(302);
    expect(await counts(emailId, teamId, "clicked")).toEqual({ events: 1, counter: 1 });
  });

  it("records a repeat click after the damping window without advancing the counter", async () => {
    const { emailId, teamId } = await seedEmail();
    const token = makeClickToken({ emailId, url: "https://shop.example.com/", secretKey });

    await clickGet(...req(token));
    await backdateEvents(emailId, "clicked", 120_000);
    await clickGet(...req(token));

    expect(await counts(emailId, teamId, "clicked")).toEqual({ events: 2, counter: 1 });
  });

  it("promotes the email status to clicked", async () => {
    const { emailId } = await seedEmail();
    const token = makeClickToken({ emailId, url: "https://x.example.com/", secretKey });
    await clickGet(...req(token));
    const [row] = await db
      .select({ status: schema.emails.latestStatus })
      .from(schema.emails)
      .where(eq(schema.emails.id, emailId));
    expect(row?.status).toBe("clicked");
  });

  it("404s a tampered token instead of redirecting off-site", async () => {
    const { emailId, teamId } = await seedEmail();
    const token = makeClickToken({
      emailId,
      url: "https://safe.example.com/",
      secretKey,
    });
    // Flip a payload character: the mac no longer matches, so nothing is signed.
    const tampered = `${token.slice(0, -3)}AAA`;

    const res = await clickGet(...req(tampered));
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(await counts(emailId, teamId, "clicked")).toEqual({ events: 0, counter: 0 });
  });

  it("404s a token signed with a foreign key (no open redirect)", async () => {
    const { emailId } = await seedEmail();
    const foreign = deriveTrackingKey(Buffer.from("A".repeat(32), "utf8"));
    const token = makeClickToken({
      emailId,
      url: "https://evil.example.com/",
      secretKey: foreign,
    });
    const res = await clickGet(...req(token));
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("open endpoint /t/o", () => {
  it("records a unique open and returns a 1x1 gif", async () => {
    const { emailId, teamId } = await seedEmail();
    const token = makeOpenToken({ emailId, secretKey });

    const res = await openGet(...req(token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 3).toString("ascii")).toBe("GIF");
    expect(await counts(emailId, teamId, "opened")).toEqual({ events: 1, counter: 1 });

    // A proxy refetch seconds later is damped: no second event, no counter move.
    await openGet(...req(token));
    expect(await counts(emailId, teamId, "opened")).toEqual({ events: 1, counter: 1 });
  });

  it("records a repeat open after the damping window without advancing the counter", async () => {
    const { emailId, teamId } = await seedEmail();
    const token = makeOpenToken({ emailId, secretKey });

    await openGet(...req(token));
    await backdateEvents(emailId, "opened", 120_000);
    await openGet(...req(token));

    expect(await counts(emailId, teamId, "opened")).toEqual({ events: 2, counter: 1 });

    // Immediately after the repeat, a third hit is inside the window again.
    await openGet(...req(token));
    expect(await counts(emailId, teamId, "opened")).toEqual({ events: 2, counter: 1 });
  });

  it("records Apple Mail Privacy Protection's fetch as prefetched: no status lift, no opened counter", async () => {
    const { emailId, teamId } = await seedEmail();
    const token = makeOpenToken({ emailId, secretKey });

    const res = await openGet(...req(token, { "user-agent": "Mozilla/5.0" }));
    expect(res.status).toBe(200);
    expect(await counts(emailId, teamId, "prefetched")).toEqual({ events: 1, counter: 1 });
    expect(await counts(emailId, teamId, "opened")).toEqual({ events: 0, counter: 0 });
    const [row] = await db
      .select({ status: schema.emails.latestStatus })
      .from(schema.emails)
      .where(eq(schema.emails.id, emailId));
    expect(row?.status).toBe("queued");
    const [event] = await db
      .select({ data: schema.emailEvents.data })
      .from(schema.emailEvents)
      .where(
        and(eq(schema.emailEvents.emailId, emailId), eq(schema.emailEvents.type, "prefetched")),
      );
    expect(event?.data).toMatchObject({ open: { reason: "apple_mpp", userAgent: "Mozilla/5.0" } });
  });

  it("marks a fetch seconds after delivery as prefetched, and the person who opens next still counts", async () => {
    const { emailId, teamId } = await seedEmail();
    const token = makeOpenToken({ emailId, secretKey });
    await db
      .insert(schema.emailEvents)
      .values({ emailId, type: "delivered", occurredAt: new Date(Date.now() - 3_000) });

    await openGet(...req(token));
    expect(await counts(emailId, teamId, "prefetched")).toEqual({ events: 1, counter: 1 });
    expect(await counts(emailId, teamId, "opened")).toEqual({ events: 0, counter: 0 });

    // The same person, well past the window: an open in its own right, not
    // damped by the prefetch a moment earlier.
    await backdateEvents(emailId, "delivered", 120_000);
    await openGet(...req(token));
    expect(await counts(emailId, teamId, "opened")).toEqual({ events: 1, counter: 1 });
    expect(await counts(emailId, teamId, "prefetched")).toEqual({ events: 1, counter: 1 });
    const [row] = await db
      .select({ status: schema.emails.latestStatus })
      .from(schema.emails)
      .where(eq(schema.emails.id, emailId));
    expect(row?.status).toBe("opened");
  });

  it("measures the window from the first delivery, not a later recipient's", async () => {
    const { emailId, teamId } = await seedEmail();
    const token = makeOpenToken({ emailId, secretKey });
    await db.insert(schema.emailEvents).values([
      { emailId, type: "delivered", occurredAt: new Date(Date.now() - 300_000) },
      { emailId, type: "delivered", occurredAt: new Date(Date.now() - 5_000) },
    ]);

    await openGet(...req(token));
    expect(await counts(emailId, teamId, "opened")).toEqual({ events: 1, counter: 1 });
    expect(await counts(emailId, teamId, "prefetched")).toEqual({ events: 0, counter: 0 });
  });

  it("stores the fetcher's address and user agent on the open", async () => {
    const { emailId } = await seedEmail();
    const token = makeOpenToken({ emailId, secretKey });
    await openGet(...req(token, { "user-agent": IPHONE, "x-forwarded-for": "203.0.113.9" }));
    const [event] = await db
      .select({ data: schema.emailEvents.data })
      .from(schema.emailEvents)
      .where(and(eq(schema.emailEvents.emailId, emailId), eq(schema.emailEvents.type, "opened")));
    expect(event?.data).toMatchObject({ open: { ipAddress: "203.0.113.9", userAgent: IPHONE } });
  });

  it("returns the gif silently for an invalid token and records nothing", async () => {
    const { emailId, teamId } = await seedEmail();
    const res = await openGet(...req("not-a-real-token"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(await counts(emailId, teamId, "opened")).toEqual({ events: 0, counter: 0 });
  });
});
