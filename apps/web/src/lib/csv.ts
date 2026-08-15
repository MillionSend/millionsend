export interface CsvContactRow {
  email: string;
  firstName?: string;
  lastName?: string;
}

/** RFC 4180 field splitter for one line: quoted fields, "" escapes, comma delimiter. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

/**
 * Client-side contact CSV parsing for the import modal. Two accepted
 * shapes: a header row containing "email" (with optional first_name /
 * last_name columns), or headerless rows whose first column is the address.
 * Rows without an "@" in the email column are dropped here — the server
 * would count them as skipped anyway.
 *
 * ponytail: lines are split on newlines before quote parsing, so a quoted
 * field containing a literal newline breaks; use a real CSV lib if
 * multi-line fields ever matter for contact imports.
 */
export function parseCsvContacts(text: string): CsvContactRow[] {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const first = lines[0];
  if (!first) return [];
  const header = splitCsvLine(first).map((h) => h.toLowerCase());
  const emailCol = header.indexOf("email");
  const mapped = emailCol !== -1;
  const firstCol = header.indexOf("first_name");
  const lastCol = header.indexOf("last_name");
  const rows: CsvContactRow[] = [];
  for (const line of mapped ? lines.slice(1) : lines) {
    const fields = splitCsvLine(line);
    const email = fields[mapped ? emailCol : 0] ?? "";
    if (!email.includes("@")) continue;
    const firstName = mapped && firstCol !== -1 ? (fields[firstCol] ?? "") : "";
    const lastName = mapped && lastCol !== -1 ? (fields[lastCol] ?? "") : "";
    rows.push({
      email,
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
    });
  }
  return rows;
}
