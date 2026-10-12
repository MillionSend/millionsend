import { describe, expect, it } from "vitest";
import { createPromiseCache } from "../src/promise-cache.js";

describe("createPromiseCache", () => {
  it("runs one computation for concurrent callers of a key", async () => {
    const cache = createPromiseCache({ maxEntries: 10, ttlMs: 1_000 });
    let runs = 0;
    const compute = async () => {
      runs++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "read";
    };
    expect(await Promise.all([cache.get("k", compute), cache.get("k", compute)])).toEqual([
      "read",
      "read",
    ]);
    expect(runs).toBe(1);
  });

  it("forgets a failure, so the next caller tries again", async () => {
    const cache = createPromiseCache({ maxEntries: 10, ttlMs: 1_000 });
    await expect(cache.get("k", () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(await cache.get("k", async () => "up")).toBe("up");
  });

  it("expires entries and drops the least recently used past the cap", async () => {
    let clock = 0;
    const cache = createPromiseCache({ maxEntries: 2, ttlMs: 100, now: () => clock });
    cache.set("a", Promise.resolve(1));
    cache.set("b", Promise.resolve(2), 10);
    cache.peek("a");
    cache.set("c", Promise.resolve(3));
    expect(cache.peek("b")).toBeUndefined();
    expect(await cache.peek("a")).toBe(1);
    clock = 100;
    expect(cache.peek("a")).toBeUndefined();
    expect(cache.peek("c")).toBeUndefined();
  });
});
