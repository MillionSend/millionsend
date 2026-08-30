import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Auth, createAuth } from "@/server/auth";

const BASE = "http://localhost:3000";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-1234");
  vi.stubEnv("APP_BASE_URL", BASE);
  vi.stubEnv("ALLOW_SIGNUP", "true");
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

async function signUp(auth: Auth, email: string, headers: Record<string, string> = {}) {
  const { headers: resHeaders, response } = await auth.api.signUpEmail({
    body: { name: email, email, password: "correct horse battery" },
    headers: new Headers(headers),
    returnHeaders: true,
  });
  const cookie = resHeaders
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { userId: response.user.id, cookie };
}

async function sessionIp(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ ipAddress: schema.session.ipAddress })
    .from(schema.session)
    .where(eq(schema.session.userId, userId));
  return row?.ipAddress ?? null;
}

describe("client IP resolution", () => {
  it("self-host: walks a forwarded chain past the loopback proxy instead of discarding it", async () => {
    const auth = createAuth(db);
    // nginx appends its view of the client after whatever the client sent.
    const { userId } = await signUp(auth, "ada@example.com", {
      "x-forwarded-for": "198.51.100.200, 203.0.113.9, 127.0.0.1",
    });
    expect(await sessionIp(userId)).toBe("203.0.113.9");
  });

  it("cloud: reads cf-connecting-ip and ignores X-Forwarded-For", async () => {
    vi.stubEnv("IS_CLOUD", "true");
    const auth = createAuth(db);
    const { userId } = await signUp(auth, "ada@example.com", {
      "cf-connecting-ip": "203.0.113.9",
      "x-forwarded-for": "198.51.100.200",
    });
    expect(await sessionIp(userId)).toBe("203.0.113.9");
  });
});

describe("account deletion", () => {
  it("refuses while the user is a team's only owner, then deletes with cascades", async () => {
    const auth = createAuth(db);
    const teamId = await createTeam(db);
    const ada = await signUp(auth, "ada@example.com");
    await db.insert(schema.teamMembers).values({ teamId, userId: ada.userId, role: "owner" });

    await expect(
      auth.api.deleteUser({ headers: new Headers({ cookie: ada.cookie }), body: {} }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
    expect(await db.select().from(schema.user)).toHaveLength(1);

    const bob = await signUp(auth, "bob@example.com");
    await db.insert(schema.teamMembers).values({ teamId, userId: bob.userId, role: "owner" });
    await expect(
      auth.api.deleteUser({ headers: new Headers({ cookie: ada.cookie }), body: {} }),
    ).resolves.toMatchObject({ success: true });
    expect((await db.select().from(schema.user)).map((u) => u.id)).toEqual([bob.userId]);
    expect(
      await db.select().from(schema.teamMembers).where(eq(schema.teamMembers.userId, ada.userId)),
    ).toHaveLength(0);
  });
});
