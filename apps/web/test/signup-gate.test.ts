import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertSignupAllowed, resolveBaseUrl } from "@/server/auth";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

describe("assertSignupAllowed", () => {
  it("allows the first user even with signup disabled", async () => {
    await expect(assertSignupAllowed(db, false)).resolves.toBeUndefined();
  });

  it("blocks registration once a user exists and signup is disabled", async () => {
    await db.insert(schema.user).values({ id: "u1", name: "u1", email: "u1@example.com" });
    await expect(assertSignupAllowed(db, false)).rejects.toMatchObject({
      status: "FORBIDDEN",
      message: "Signup is disabled.",
    });
  });

  it("allows registration with ALLOW_SIGNUP=true regardless of existing users", async () => {
    await db.insert(schema.user).values({ id: "u1", name: "u1", email: "u1@example.com" });
    await expect(assertSignupAllowed(db, true)).resolves.toBeUndefined();
  });
});

describe("resolveBaseUrl", () => {
  it("defaults to localhost and warns when unset — never throws", () => {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (msg: string) => {
      warned.push(msg);
    };
    try {
      expect(resolveBaseUrl(undefined)).toBe("http://localhost:3000");
    } finally {
      console.warn = original;
    }
    expect(warned.join(" ")).toContain("APP_BASE_URL");
  });

  it("returns APP_BASE_URL when set", () => {
    expect(resolveBaseUrl("https://mail.example.com")).toBe("https://mail.example.com");
  });
});
