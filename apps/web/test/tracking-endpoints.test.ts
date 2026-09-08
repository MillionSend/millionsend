import { deriveTrackingKey, makeClickToken, makeOpenToken } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb, createWebhookEndpoint } from "@millionsend/test-utils";
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
// Delivery rows are asserted on directly; nothing here drains them.
vi.mock("@/server/queue", () => ({ enqueueWebhookDeliveries: async () => {} }));

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

  it("a person who clicks a second link within a minute has both clicks recorded, counted once", async () => {
    const { emailId, teamId } = await seedEmail();
    await clickGet(
      ...req(makeClickToken({ emailId, url: "https://shop.example.com/a", secretKey })),
    );
    // Seconds later: past the burst window, inside the damping one.
    await backdateEvents(emailId, "clicked", 5_000);
    await clickGet(
      ...req(makeClickToken({ emailId, url: "https://shop.example.com/b", secretKey })),
    );
    expect(await counts(emailId, teamId, "clicked")).toEqual({ events: 2, counter: 1 });
    expect(await counts(emailId, teamId, "opened")).toEqual({ events: 1, counter: 1 });
  });

  it("a desktop Chrome reporting a build number no browser sends is a prefetch, on the pixel and on a link", async () => {
    const { emailId, teamId } = await seedEmail();
    const spoofed = {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.163 Safari/537.36",
    };
    await db
      .insert(schema.emailEvents)
      .values({ emailId, type: "delivered", occurredAt: new Date(Date.now() - 45_000) });
    await openGet(...req(makeOpenToken({ emailId, secretKey }), spoofed));
    const url = "https://shop.example.com/";
    const res = await clickGet(...req(makeClickToken({ emailId, url, secretKey }), spoofed));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(url);
    // Two prefetch rows (the pixel, the link), one email prefetched.
    expect(await counts(emailId, teamId, "prefetched")).toEqual({ events: 2, counter: 1 });
    expect(await counts(emailId, teamId, "opened")).toEqual({ events: 0, counter: 0 });
    expect(await counts(emailId, teamId, "clicked")).toEqual({ events: 0, counter: 0 });
    const rows = await db
      .select({ data: schema.emailEvents.data })
      .from(schema.emailEvents)
      .where(
        and(eq(schema.emailEvents.emailId, emailId), eq(schema.emailEvents.type, "prefetched")),
      );
    expect(
      rows.map((r) => r.data as { open?: { reason?: string }; click?: { reason?: string } }),
    ).toEqual([
      { open: expect.objectContaining({ reason: "spoofed_ua" }) },
      { click: expect.objectContaining({ reason: "spoofed_ua", link: url }) },
    ]);
    const [row] = await db
      .select({ status: schema.emails.latestStatus })
      .from(schema.emails)
      .where(eq(schema.emails.id, emailId));
    expect(row?.status).toBe("queued");
    // The person on a current Chrome, later, is a click.
    await clickGet(
      ...req(makeClickToken({ emailId, url, secretKey }), {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
      }),
    );
    expect(await counts(emailId, teamId, "clicked")).toEqual({ events: 1, counter: 1 });
  });

  it("a click on a message with no open yet records the open too, marked as inferred", async () => {
    const { emailId, teamId } = await seedEmail();
    const token = makeClickToken({ emailId, url: "https://shop.example.com/", secretKey });
    await clickGet(...req(token));
    expect(await counts(emailId, teamId, "clicked")).toEqual({ events: 1, counter: 1 });
    expect(await counts(emailId, teamId, "opened")).toEqual({ events: 1, counter: 1 });
    const rows = await db
      .select({
        type: schema.emailEvents.type,
        occurredAt: schema.emailEvents.occurredAt,
        data: schema.emailEvents.data,
      })
      .from(schema.emailEvents)
      .where(eq(schema.emailEvents.emailId, emailId))
      .orderBy(schema.emailEvents.occurredAt);
    expect(rows.map((r) => r.type)).toEqual(["opened", "clicked"]);
    expect(rows[0]?.data).toMatchObject({ open: { reason: "click", userAgent: IPHONE } });
    // A second click adds no second open.
    await backdateEvents(emailId, "clicked", 120_000);
    await clickGet(...req(token));
    expect(await counts(emailId, teamId, "opened")).toEqual({ events: 1, counter: 1 });
  });

  it("a click after a real open adds no open", async () => {
    const { emailId, teamId } = await seedEmail();
    await openGet(...req(makeOpenToken({ emailId, secretKey })));
    await clickGet(...req(makeClickToken({ emailId, url: "https://x.example.com/", secretKey })));
    expect(await counts(emailId, teamId, "opened")).toEqual({ events: 1, counter: 1 });
    const [open] = await db
      .select({ data: schema.emailEvents.data })
      .from(schema.emailEvents)
      .where(and(eq(schema.emailEvents.emailId, emailId), eq(schema.emailEvents.type, "opened")));
    expect((open?.data as { open?: { reason?: string } })?.open?.reason).toBeUndefined();
  });

  it("a link a security scanner follows is a prefetch, not a click, and still redirects", async () => {
    const { emailId, teamId } = await seedEmail();
    const url = "https://shop.example.com/";
    const token = makeClickToken({ emailId, url, secretKey });
    const res = await clickGet(...req(token, { "user-agent": "Barracuda Sentinel (EE)" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(url);
    expect(await counts(emailId, teamId, "clicked")).toEqual({ events: 0, counter: 0 });
    expect(await counts(emailId, teamId, "opened")).toEqual({ events: 0, counter: 0 });
    expect(await counts(emailId, teamId, "prefetched")).toEqual({ events: 1, counter: 1 });
    const [event] = await db
      .select({ data: schema.emailEvents.data })
      .from(schema.emailEvents)
      .where(
        and(eq(schema.emailEvents.emailId, emailId), eq(schema.emailEvents.type, "prefetched")),
      );
    expect(event?.data).toMatchObject({ click: { link: url, reason: "scanner" } });
    const [row] = await db
      .select({ status: schema.emails.latestStatus })
      .from(schema.emails)
      .where(eq(schema.emails.id, emailId));
    expect(row?.status).toBe("queued");
  });

  it("Apple Mail's prefetch followed by the reader's click yields the open and the click", async () => {
    const { emailId, teamId } = await seedEmail();
    await openGet(...req(makeOpenToken({ emailId, secretKey }), { "user-agent": "Mozilla/5.0" }));
    expect(await counts(emailId, teamId, "opened")).toEqual({ events: 0, counter: 0 });
    await clickGet(...req(makeClickToken({ emailId, url: "https://x.example.com/", secretKey })));
    expect(await counts(emailId, teamId, "opened")).toEqual({ events: 1, counter: 1 });
    expect(await counts(emailId, teamId, "clicked")).toEqual({ events: 1, counter: 1 });
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

describe("click bursts", () => {
  const DESKTOP =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
  const human = { "user-agent": DESKTOP };
  const link = (name: string) => `https://shop.example.com/${name}`;
  const click = (emailId: string, name: string, headers = human) =>
    clickGet(...req(makeClickToken({ emailId, url: link(name), secretKey }), headers));

  async function seedDelivered(emailId: string, agoMs = 40_000) {
    await db
      .insert(schema.emailEvents)
      .values({ emailId, type: "delivered", occurredAt: new Date(Date.now() - agoMs) });
  }
  async function status(emailId: string) {
    const [row] = await db
      .select({ status: schema.emails.latestStatus })
      .from(schema.emails)
      .where(eq(schema.emails.id, emailId));
    return row?.status;
  }
  async function reasons(emailId: string) {
    const rows = await db
      .select({ data: schema.emailEvents.data })
      .from(schema.emailEvents)
      .where(
        and(eq(schema.emailEvents.emailId, emailId), eq(schema.emailEvents.type, "prefetched")),
      )
      .orderBy(schema.emailEvents.occurredAt);
    return rows.map((row) => (row.data as { click?: { reason?: string } }).click?.reason);
  }
  async function deliveriesOf(endpointId: string) {
    return db
      .select({
        eventType: schema.webhookDeliveries.eventType,
        payload: schema.webhookDeliveries.payload,
      })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.endpointId, endpointId))
      .orderBy(schema.webhookDeliveries.createdAt);
  }

  it("every link hit within a second is a machine's: no click, no open, one prefetch, status untouched", async () => {
    const { emailId, teamId } = await seedEmail();
    await seedDelivered(emailId);
    for (const name of ["a", "b", "c", "d"]) {
      const res = await click(emailId, name);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(link(name));
    }
    expect(await counts(emailId, teamId, "clicked")).toEqual({ events: 0, counter: 0 });
    expect(await counts(emailId, teamId, "opened")).toEqual({ events: 0, counter: 0 });
    expect(await counts(emailId, teamId, "prefetched")).toEqual({ events: 4, counter: 1 });
    expect(await reasons(emailId)).toEqual(["burst", "burst", "burst", "burst"]);
    expect(await status(emailId)).toBe("delivered");
  });

  it("a click promoted before its burst was visible is taken back: row, inferred open, counters, status, pending deliveries", async () => {
    const { emailId, teamId } = await seedEmail();
    await seedDelivered(emailId);
    const everything = await createWebhookEndpoint(db, teamId, null);
    const optIn = await createWebhookEndpoint(db, teamId, ["email.prefetched"]);

    await click(emailId, "a");
    expect(await counts(emailId, teamId, "clicked")).toEqual({ events: 1, counter: 1 });
    expect(await counts(emailId, teamId, "opened")).toEqual({ events: 1, counter: 1 });
    expect(await status(emailId)).toBe("clicked");
    expect((await deliveriesOf(everything)).map((d) => d.eventType).sort()).toEqual([
      "email.clicked",
      "email.opened",
    ]);
    const [clickedRow] = await db
      .select({ occurredAt: schema.emailEvents.occurredAt })
      .from(schema.emailEvents)
      .where(and(eq(schema.emailEvents.emailId, emailId), eq(schema.emailEvents.type, "clicked")));

    await click(emailId, "b");
    expect(await counts(emailId, teamId, "clicked")).toEqual({ events: 0, counter: 0 });
    expect(await counts(emailId, teamId, "opened")).toEqual({ events: 0, counter: 0 });
    expect(await counts(emailId, teamId, "prefetched")).toEqual({ events: 2, counter: 1 });
    expect(await reasons(emailId)).toEqual(["burst", "burst"]);
    expect(await status(emailId)).toBe("delivered");
    // The unposted click and open never leave; the retraction reaches only
    // endpoints that opted into prefetches, stamped with the click's own time.
    expect(await deliveriesOf(everything)).toEqual([]);
    const retractions = await deliveriesOf(optIn);
    expect(retractions.map((d) => d.eventType)).toEqual(["email.prefetched", "email.prefetched"]);
    expect(
      retractions.map((d) => (d.payload as { data: { click: { link: string } } }).data.click.link),
    ).toEqual([link("a"), link("b")]);
    expect(retractions[0]?.payload).toMatchObject({
      created_at: clickedRow?.occurredAt.toISOString(),
      data: { click: { reason: "burst", timestamp: clickedRow?.occurredAt.toISOString() } },
    });
    const [hour] = await db
      .select()
      .from(schema.usageCountersHourly)
      .where(eq(schema.usageCountersHourly.teamId, teamId));
    expect(hour).toMatchObject({ clicked: 0, opened: 0, prefetched: 1 });
  });

  it("a person's real open stands through a burst on the links", async () => {
    const { emailId, teamId } = await seedEmail();
    await seedDelivered(emailId, 120_000);
    await openGet(...req(makeOpenToken({ emailId, secretKey })));
    await click(emailId, "a");
    await click(emailId, "b");
    expect(await counts(emailId, teamId, "opened")).toEqual({ events: 1, counter: 1 });
    expect(await counts(emailId, teamId, "clicked")).toEqual({ events: 0, counter: 0 });
    expect(await counts(emailId, teamId, "prefetched")).toEqual({ events: 2, counter: 1 });
    expect(await status(emailId)).toBe("opened");
  });

  it("an earlier click by a person stands when a machine bursts later", async () => {
    const { emailId, teamId } = await seedEmail();
    await seedDelivered(emailId, 120_000);
    await click(emailId, "a");
    await backdateEvents(emailId, "clicked", 90_000);
    await click(emailId, "b");
    await click(emailId, "c");
    expect(await counts(emailId, teamId, "clicked")).toEqual({ events: 1, counter: 1 });
    expect(await counts(emailId, teamId, "prefetched")).toEqual({ events: 2, counter: 1 });
    expect(await reasons(emailId)).toEqual(["burst", "burst"]);
    expect(await status(emailId)).toBe("clicked");
  });

  it("two links two seconds apart are two clicks", async () => {
    const { emailId, teamId } = await seedEmail();
    await seedDelivered(emailId);
    await click(emailId, "a");
    await backdateEvents(emailId, "clicked", 2_000);
    await click(emailId, "b");
    expect(await counts(emailId, teamId, "clicked")).toEqual({ events: 2, counter: 1 });
    expect(await status(emailId)).toBe("clicked");
  });

  it("a machine that also names itself keeps its own reason, and folds the clean hit before it", async () => {
    const { emailId, teamId } = await seedEmail();
    await seedDelivered(emailId);
    await click(emailId, "a");
    await click(emailId, "b", {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.163 Safari/537.36",
    });
    expect(await reasons(emailId)).toEqual(["burst", "spoofed_ua"]);
    expect(await counts(emailId, teamId, "clicked")).toEqual({ events: 0, counter: 0 });
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
