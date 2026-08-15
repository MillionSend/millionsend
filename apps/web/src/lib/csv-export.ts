/**
 * RFC 4180 CSV serialization for dashboard table exports — the write-side
 * mirror of parseCsvContacts in ./csv (which is read-only). Kept pure so the
 * row escaping is unit-tested without an HTTP stream.
 */

/** A field is quoted when it contains a delimiter, quote, or line break. */
const NEEDS_QUOTING = /[",\r\n]/;

/**
 * Spreadsheet formula-injection triggers: Excel/Sheets evaluate a cell whose
 * first character is one of these, so a stored value like `=HYPERLINK(...)`
 * would run on open. Leading whitespace variants (tab, CR) count too.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | boolean | Date | null | undefined;
}

function render(value: string | number | boolean | Date | null | undefined): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function escapeField(raw: string): string {
  // Neutralize by prefixing a single quote: the value is preserved as text and
  // no longer parses as a formula. Applied before quoting so the prefixed cell
  // still gets wrapped if it also contains a delimiter.
  const safe = FORMULA_LEAD.test(raw) ? `'${raw}` : raw;
  return NEEDS_QUOTING.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Serializes rows to an RFC 4180 document (CRLF line breaks, header row from
 * the column defs). The optional BOM makes Excel open UTF-8 without mojibake.
 */
export function toCsv<T>(
  rows: readonly T[],
  columns: readonly CsvColumn<T>[],
  opts?: { bom?: boolean },
): string {
  const header = columns.map((c) => escapeField(c.header)).join(",");
  const body = rows.map((row) => columns.map((c) => escapeField(render(c.value(row)))).join(","));
  const doc = `${[header, ...body].join("\r\n")}\r\n`;
  return opts?.bom ? `﻿${doc}` : doc;
}
