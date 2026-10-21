import type { Db } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resultRows } from "../src/driver-result.js";
import { parsePropertyDate } from "../src/property-date.js";
import { propertyDateSql } from "../src/segment-filter.js";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const DATES: [string, string][] = [
  ["2026-01-08", "2026-01-08T00:00:00.000Z"],
  ["  2026-01-08 ", "2026-01-08T00:00:00.000Z"],
  ["2024-02-29", "2024-02-29T00:00:00.000Z"],
  ["2026-01-08T10:30", "2026-01-08T10:30:00.000Z"],
  ["2026-01-08 10:30", "2026-01-08T10:30:00.000Z"],
  ["2026-01-08T10:30:15", "2026-01-08T10:30:15.000Z"],
  ["2026-01-08T10:30:15.25", "2026-01-08T10:30:15.250Z"],
  ["2026-01-08T10:30:15.123456", "2026-01-08T10:30:15.123Z"],
  ["2026-01-08T10:30:15.123456789", "2026-01-08T10:30:15.123Z"],
  ["2026-01-08T10:30:00Z", "2026-01-08T10:30:00.000Z"],
  ["2026-01-08T10:30:00-03:00", "2026-01-08T13:30:00.000Z"],
  ["2026-01-08 10:30+0530", "2026-01-08T05:00:00.000Z"],
  ["2026-01-08T10:30:00+03", "2026-01-08T07:30:00.000Z"],
  ["2026-01-08T10:30:00+14:00", "2026-01-07T20:30:00.000Z"],
  ["0001-01-01", "0001-01-01T00:00:00.000Z"],
  ["9999-12-31T23:59:59Z", "9999-12-31T23:59:59.000Z"],
  ["946684800", "2000-01-01T00:00:00.000Z"],
  ["4102444800", "2100-01-01T00:00:00.000Z"],
  ["1767225600", "2026-01-01T00:00:00.000Z"],
  ["01767225600", "2026-01-01T00:00:00.000Z"],
  ["946684800000", "2000-01-01T00:00:00.000Z"],
  ["1767225600123", "2026-01-01T00:00:00.123Z"],
  // Date.now() / 1000 and time.time() write a fraction.
  ["1767225600.5", "2026-01-01T00:00:00.500Z"],
  ["1767225600123.5", "2026-01-01T00:00:00.123Z"],
  ["4102444800000", "2100-01-01T00:00:00.000Z"],
];

const NOT_DATES = [
  "",
  "   ",
  // Counts and years: Unix time before 2000.
  "3",
  "1500",
  "2026",
  "20260108",
  "946684799",
  // Past 2100 in seconds, and short of 2000 in milliseconds.
  "4102444801",
  "946684799999",
  "4102444800001",
  "99999999999999999999",
  "3.5",
  "1767225600.",
  ".5",
  "-1767225600",
  "true",
  "yes",
  "now",
  "Jan 8, 2026",
  "08/01/2026",
  "2026-02-30",
  "2026-02-29",
  "2026-13-01",
  "2026-00-10",
  "2026-01-00",
  "2026-01-32",
  "0000-01-01",
  "+010000-01-01",
  "2026-1-8",
  "26-01-08",
  "\t2026-01-08",
  "2026-01-08\n",
  "2026-01-08T10",
  "2026-01-08T24:00",
  "2026-01-08T10:60",
  "2026-01-08T23:59:60",
  "2026-01-08T10:30:00.",
  "2026-01-08T10:30:00.1234567891",
  // Postgres refuses a fraction this long.
  `2026-01-08T10:30:00.${"1".repeat(200)}`,
  "2026-01-08t10:30",
  "2026-01-08T10:30:00z",
  "2026-01-08T10:30:00+15:00",
  "2026-01-08T10:30:00+03:60",
  "2026-01-08T10:30:00 Z",
  "2026-01-08T10:30:00UTC",
];

describe("parsePropertyDate", () => {
  it("reads ISO dates and date-times, in UTC when no zone is named, and Unix time from 2000 to 2100", () => {
    for (const [value, iso] of DATES) {
      expect(parsePropertyDate(value)?.toISOString(), value).toBe(iso);
    }
  });

  it("reads anything else as no date", () => {
    for (const value of NOT_DATES) {
      expect(parsePropertyDate(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("propertyDateSql", () => {
  it("reads every value as parsePropertyDate does", async () => {
    const values = [...DATES.map(([value]) => value), ...NOT_DATES];
    // unnest, not one bound literal per query: the values reach the CASE as
    // row data, the way stored properties do.
    const rows = resultRows<{ v: string; at_ms: number | null }>(
      await db.execute(sql`
        select t.v, (extract(epoch from ${propertyDateSql(sql`t.v`)}) * 1000)::float8 as at_ms
        from unnest(array[${sql.join(
          values.map((v) => sql`${v}`),
          sql`, `,
        )}]::text[]) as t(v)
      `),
    );
    expect(rows).toHaveLength(values.length);
    for (const row of rows) {
      const sqlMs = row.at_ms === null ? null : Math.floor(Number(row.at_ms));
      expect(sqlMs, JSON.stringify(row.v)).toBe(parsePropertyDate(row.v)?.getTime() ?? null);
    }
  });
});
