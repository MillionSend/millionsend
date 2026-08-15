import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLastAudience, writeLastAudience } from "@/lib/last-audience";

// Minimal localStorage stand-in: the node test env has no DOM.
function installLocalStorage() {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
}

describe("last-audience persistence", () => {
  beforeEach(installLocalStorage);
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("round-trips the selection and scopes it per team", () => {
    expect(readLastAudience("team-a")).toBeNull();
    writeLastAudience("team-a", "aud-1");
    expect(readLastAudience("team-a")).toBe("aud-1");
    // A different team must not see team-a's selection.
    expect(readLastAudience("team-b")).toBeNull();
    writeLastAudience("team-a", "aud-2");
    expect(readLastAudience("team-a")).toBe("aud-2");
  });

  it("returns null instead of throwing when storage is unavailable", () => {
    Reflect.deleteProperty(globalThis, "localStorage");
    expect(readLastAudience("team-a")).toBeNull();
    expect(() => writeLastAudience("team-a", "aud-1")).not.toThrow();
  });
});
