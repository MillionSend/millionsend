import type { Db } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DISPOSABLE_LIST_URL,
  disposableDomains,
  isDisposableDomain,
  parseDomainList,
  refreshDisposableDomains,
} from "../src/disposable-domains.js";

const list = new Set(["mailinator.com", "yopmail.com"]);

describe("isDisposableDomain", () => {
  it("matches the domain and every parent, never a sibling", () => {
    expect(isDisposableDomain("mailinator.com", list)).toBe(true);
    expect(isDisposableDomain("sub.mailinator.com", list)).toBe(true);
    expect(isDisposableDomain("a.b.mailinator.com", list)).toBe(true);
    expect(isDisposableDomain("MAILINATOR.Com.", list)).toBe(true);
    expect(isDisposableDomain("notmailinator.com", list)).toBe(false);
    expect(isDisposableDomain("mailinator.com.example.com", list)).toBe(false);
    expect(isDisposableDomain("com", list)).toBe(false);
    expect(isDisposableDomain("gmail.com", list)).toBe(false);
  });

  it("never blocks a consumer mailbox provider or a whole public suffix, whatever the list says", () => {
    const poisoned = new Set(["gmail.com", "uol.com.br", "ig.com.br", "com.br", "github.io"]);
    for (const domain of ["gmail.com", "uol.com.br", "ig.com.br", "mail.uol.com.br"]) {
      expect(isDisposableDomain(domain, poisoned), domain).toBe(false);
    }
    expect(isDisposableDomain("acme.com.br", poisoned)).toBe(false);
    expect(isDisposableDomain("someone.github.io", poisoned)).toBe(false);
  });
});

describe("parseDomainList", () => {
  it("keeps the domains and drops comments, blanks, junk and public suffixes", () => {
    expect(
      parseDomainList(
        "# list\n0-mail.com\n\n  MAILINATOR.com  \r\n<html>\nnot a domain\ncom.br\ngithub.io\nx.dynv6.net\n",
      ),
    ).toEqual(["0-mail.com", "mailinator.com", "x.dynv6.net"]);
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

  it("holds back a list that grew or shrank by more than a fifth in a day", async () => {
    const download = (size: number) => async () =>
      Buffer.from(Array.from({ length: size }, (_, i) => `throwaway${i}.example`).join("\n"));
    await refreshDisposableDomains(db, {
      download: download(1200),
      now: at("2026-10-10T05:10:00Z"),
    });
    for (const size of [1500, 900]) {
      expect(
        await refreshDisposableDomains(db, {
          download: download(size),
          now: at("2026-10-11T05:10:00Z"),
        }),
        String(size),
      ).toBe("kept");
    }
    expect((await disposableDomains(db, shipped)).size).toBe(1200);
    expect(
      await refreshDisposableDomains(db, {
        download: download(1400),
        now: at("2026-10-11T05:10:00Z"),
      }),
    ).toBe("stored");
    expect((await disposableDomains(db, shipped)).size).toBe(1400);
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
