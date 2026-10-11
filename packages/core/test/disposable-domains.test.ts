import type { Db } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DISPOSABLE_LIST_URL,
  disposableDomains,
  isListedDomain,
  parseDomainList,
  refreshDisposableDomains,
} from "../src/disposable-domains.js";

const list = new Set(["mailinator.com", "yopmail.com"]);

describe("isListedDomain", () => {
  it("matches the domain and every parent, never a sibling", () => {
    expect(isListedDomain("mailinator.com", list)).toBe(true);
    expect(isListedDomain("sub.mailinator.com", list)).toBe(true);
    expect(isListedDomain("a.b.mailinator.com", list)).toBe(true);
    expect(isListedDomain("MAILINATOR.Com.", list)).toBe(true);
    expect(isListedDomain("notmailinator.com", list)).toBe(false);
    expect(isListedDomain("mailinator.com.example.com", list)).toBe(false);
    expect(isListedDomain("link", list)).toBe(false);
    expect(isListedDomain("gmail.com", list)).toBe(false);
  });
});

describe("parseDomainList", () => {
  it("keeps the domains and drops comments, blanks and junk", () => {
    expect(
      parseDomainList("# list\n0-mail.com\n\n  MAILINATOR.com  \r\n<html>\nnot a domain\n"),
    ).toEqual(["0-mail.com", "mailinator.com"]);
  });
});

describe("refreshDisposableDomains", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeEach(async () => {
    ({ db, close } = await createTestDb());
  });
  afterEach(() => close());

  const shipped = new Set(["shipped.example"]);
  const upstream = (extra: string[] = []) =>
    Buffer.from(
      [...Array.from({ length: 1200 }, (_, i) => `throwaway${i}.example`), ...extra].join("\n"),
    );
  const at = (iso: string) => new Date(iso);

  it("replaces the shipped list with the downloaded one, once a day", async () => {
    expect(await disposableDomains(db, shipped)).toBe(shipped);
    const asked: string[] = [];
    const download = async (url: string) => {
      asked.push(url);
      return upstream(["mailinator.com"]);
    };
    expect(await refreshDisposableDomains(db, { download, now: at("2026-10-11T05:10:00Z") })).toBe(
      "stored",
    );
    expect(asked).toEqual([DISPOSABLE_LIST_URL]);
    const stored = await disposableDomains(db, shipped);
    expect(stored.has("mailinator.com")).toBe(true);
    expect(stored.has("shipped.example")).toBe(false);

    // A worker restart the same morning downloads nothing.
    expect(await refreshDisposableDomains(db, { download, now: at("2026-10-11T09:00:00Z") })).toBe(
      "fresh",
    );
    expect(asked).toHaveLength(1);
    expect(await refreshDisposableDomains(db, { download, now: at("2026-10-12T05:10:00Z") })).toBe(
      "stored",
    );
    expect(asked).toHaveLength(2);
  });

  it("keeps the last good copy when the download fails or is too short to be the list", async () => {
    await refreshDisposableDomains(db, {
      download: async () => upstream(["mailinator.com"]),
      now: at("2026-10-10T05:10:00Z"),
    });
    for (const download of [
      async () => {
        throw new Error("raw.githubusercontent.com answered 503");
      },
      async () => Buffer.from("<html>rate limited</html>\nmailinator.com"),
    ]) {
      expect(
        await refreshDisposableDomains(db, { download, now: at("2026-10-11T05:10:00Z") }),
      ).toBe("kept");
    }
    expect((await disposableDomains(db, shipped)).has("mailinator.com")).toBe(true);
  });
});
