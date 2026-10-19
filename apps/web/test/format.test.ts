import { describe, expect, it } from "vitest";
import {
  abbreviateDkim,
  addrSpec,
  formatBytes,
  formatDayUtc,
  formatDurationShort,
  formatHoursMinutes,
  formatMoneyTotals,
  formatTimeLeft,
  formatUsd,
  formatUtcMinute,
  formatUtcTimestampMs,
  maskApiKey,
  senderName,
} from "@/lib/format";

describe("formatDayUtc", () => {
  it("renders the UTC day key without a local-zone shift", () => {
    // Whatever the runner's zone, the label must be the key's own day.
    expect(formatDayUtc("2026-08-13", "en")).toBe("Aug 13");
    expect(formatDayUtc("2026-01-01", "en")).toBe("Jan 1");
  });
});

describe("formatUsd", () => {
  it("prints a bare $ with cents, and a tenth of a cent when asked for 3 digits", () => {
    expect(formatUsd(3150, "pt-BR")).toBe("$31,50");
    expect(formatUsd(2000, "en")).toBe("$20");
    expect(formatUsd(10.5, "pt-BR", 3)).toBe("$0,105");
    expect(formatUsd(10, "pt-BR", 3)).toBe("$0,10");
    expect(formatUsd(10.5, "en")).toBe("$0.11");
  });
});

describe("formatHoursMinutes", () => {
  it("renders h/m countdowns, dropping a zero hour", () => {
    expect(formatHoursMinutes(5 * 3_600_000 + 32 * 60_000)).toBe("5h 32m");
    expect(formatHoursMinutes(48 * 60_000)).toBe("48m");
    expect(formatHoursMinutes(0)).toBe("0m");
  });
});

describe("formatBytes", () => {
  it("picks B/KB/MB by magnitude and trims trailing zeros", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(12_698)).toBe("12.4 KB");
    expect(formatBytes(65_536)).toBe("64 KB");
    expect(formatBytes(1_258_291)).toBe("1.2 MB");
  });
});

describe("formatDurationShort", () => {
  it("picks the unit by magnitude and trims trailing zeros", () => {
    expect(formatDurationShort(21)).toBe("21 ms");
    expect(formatDurationShort(1920)).toBe("1.92 s");
    expect(formatDurationShort(2300)).toBe("2.3 s");
    expect(formatDurationShort(384_000)).toBe("6.4 m");
    expect(formatDurationShort(4_320_000)).toBe("1.2 h");
    expect(formatDurationShort(259_200_000)).toBe("3 d");
  });
});

describe("utc timestamps", () => {
  it("renders millisecond and minute precision", () => {
    const d = new Date("2026-08-12T14:03:20.208Z");
    expect(formatUtcTimestampMs(d)).toBe("2026-08-12 14:03:20.208 UTC");
    expect(formatUtcMinute(d)).toBe("2026-08-12 14:03 UTC");
  });
});

describe("maskApiKey", () => {
  it("masks everything after the scheme, keeping the last 4", () => {
    expect(maskApiKey("ms_abc123", "wxyz")).toBe("ms_••••••••wxyz");
  });

  it("is unaffected by underscores inside the base64url secret chars", () => {
    expect(maskApiKey("ms_ab_c1d", "wxyz")).toBe("ms_••••••••wxyz");
  });

  it("falls back to the whole prefix when the scheme is unrecognized", () => {
    expect(maskApiKey("legacy", "wxyz")).toBe("legacy••••••••wxyz");
  });
});

describe("abbreviateDkim", () => {
  it("keeps the tag, a distinguishing slice and the tail; leaves other values alone", () => {
    const key = `MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA02w+k3GAoJB5AafV${"x".repeat(300)}IDAQAB`;
    expect(abbreviateDkim(`"v=DKIM1; k=rsa; p=${key}"`)).toBe(
      '"v=DKIM1; k=rsa; p=MIIB…02w+k3GAoJB5AafV…IDAQAB"',
    );
    expect(abbreviateDkim('"v=spf1 include:amazonses.com ~all"')).toBe(
      '"v=spf1 include:amazonses.com ~all"',
    );
  });
});

describe("formatMoneyTotals", () => {
  it("sums per currency: US dollars as formatUsd writes them, any other as the locale does", () => {
    const usd = (amount: number) => ({ amount, currency: "usd" });
    expect(formatMoneyTotals([usd(2000), usd(2000)], "en")).toBe("$40");
    expect(formatMoneyTotals([usd(2050), { amount: 9800, currency: "brl" }], "pt-BR")).toBe(
      "$20,50 + R$\u00a098,00",
    );
    expect(formatMoneyTotals([{ amount: 500, currency: "jpy" }], "en")).toBe("¥500");
    expect(formatMoneyTotals([], "en")).toBe("");
  });
});

describe("addrSpec", () => {
  it("reads the address the From value ends with, never one its display name carries", () => {
    expect(addrSpec("Ana <ana@sender.example>")).toBe("ana@sender.example");
    expect(addrSpec("ana@sender.example")).toBe("ana@sender.example");
    expect(addrSpec('"Bank <alerts@bank.example>" <promo@attacker.example>')).toBe(
      "promo@attacker.example",
    );
  });
});

describe("senderName", () => {
  it("reads a From value as its display name, else its address", () => {
    expect(senderName('"Ana Souza" <ana@sender.example>')).toBe("Ana Souza");
    expect(senderName("Ana <ana@sender.example>")).toBe("Ana");
    expect(senderName("<ana@sender.example>")).toBe("ana@sender.example");
    expect(senderName("ana@sender.example")).toBe("ana@sender.example");
    expect(senderName(null)).toBe("");
  });
});

describe("formatTimeLeft", () => {
  it("rounds to one compact unit", () => {
    expect(formatTimeLeft(30_000)).toBe("1m");
    expect(formatTimeLeft(45 * 60_000)).toBe("45m");
    expect(formatTimeLeft(23 * 3_600_000 + 20 * 60_000)).toBe("23h");
    expect(formatTimeLeft(7 * 86_400_000)).toBe("7d");
  });
});
