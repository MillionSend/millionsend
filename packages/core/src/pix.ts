/**
 * Pix BR Codes: the EMV payload behind a Pix QR code, also pasted as text
 * ("Pix copia e cola"). What it yields is who gets paid, where and how much,
 * and the kind of key: never the key itself, which can be a person's CPF,
 * phone or e-mail. Layout and CRC per BCB's "Manual de Padrões para
 * Iniciação do Pix" (EMV QRCPS-MPM).
 */

export type PixKeyKind = "cpf" | "cnpj" | "phone" | "email" | "random";

export interface PixCode {
  /** Merchant name (field 59). */
  payee: string;
  /** Merchant city (field 60). */
  city: string;
  /** Transaction amount (field 54), only in BCB's form; null when absent or written otherwise. */
  amount: string | null;
  /** Null on a dynamic code, which carries a payment URL instead of a key. */
  key: PixKeyKind | null;
}

const PIX_GUI = "br.gov.bcb.pix";
/** Field 54 as the BCB manual writes it: digits, an optional two-place decimal, 13 characters at most. */
const PIX_AMOUNT = /^\d{1,10}(?:\.\d{2})?$/;
/** Longer than any valid BR Code, so a scan never walks far past a false start. */
const MAX_PAYLOAD_CHARS = 1024;

/** CRC16-CCITT-FALSE (poly 0x1021, init 0xFFFF) over the payload up to and including "6304". */
function crc16(payload: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(payload, "utf8")) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** Walks ID(2) LEN(2) VALUE fields from `start`; null on a malformed field. */
function fields(s: string, start = 0, end = s.length): Map<string, string> | null {
  const out = new Map<string, string>();
  for (let p = start; p < end; ) {
    const head = s.slice(p, p + 4);
    if (!/^\d{4}$/.test(head)) return null;
    const length = Number(head.slice(2));
    const value = s.slice(p + 4, p + 4 + length);
    if (value.length !== length || p + 4 + length > end) return null;
    out.set(head.slice(0, 2), value);
    p += 4 + length;
  }
  return out;
}

function keyKind(key: string): PixKeyKind {
  if (/^\+\d{8,15}$/.test(key)) return "phone";
  if (key.includes("@")) return "email";
  if (/^\d{11}$/.test(key)) return "cpf";
  if (/^\d{14}$/.test(key)) return "cnpj";
  return "random";
}

/** A whole payload, as decoded from a QR code; null unless it is a Pix code with a valid CRC. */
export function parsePix(payload: string): PixCode | null {
  const text = payload.trim();
  if (!text.startsWith("000201") || text.length > MAX_PAYLOAD_CHARS) return null;
  const top = fields(text);
  if (!top || !/^6304[0-9A-Fa-f]{4}$/.test(text.slice(-8))) return null;
  if (crc16(text.slice(0, -4)) !== text.slice(-4).toUpperCase()) return null;
  let account: Map<string, string> | null = null;
  for (let id = 26; id <= 51 && !account; id++) {
    const template = top.get(String(id));
    const sub = template === undefined ? null : fields(template);
    if (sub?.get("00")?.toLowerCase() === PIX_GUI) account = sub;
  }
  if (!account) return null;
  const key = account.get("01");
  const amount = top.get("54");
  return {
    payee: top.get("59") ?? "",
    city: top.get("60") ?? "",
    amount: amount !== undefined && PIX_AMOUNT.test(amount) ? amount : null,
    key: key ? keyKind(key) : null,
  };
}

/** The end of the payload starting at `start`: just past its CRC field, or -1. */
function payloadEnd(s: string, start: number): number {
  const limit = Math.min(s.length, start + MAX_PAYLOAD_CHARS);
  for (let p = start; p + 4 <= limit; ) {
    const head = s.slice(p, p + 4);
    if (!/^\d{4}$/.test(head)) return -1;
    p += 4 + Number(head.slice(2));
    if (head.startsWith("63")) return p <= limit ? p : -1;
  }
  return -1;
}

/**
 * Pix codes pasted into text. Line breaks are dropped first: extracted PDF
 * text wraps a long payload, and a payload never holds one.
 */
export function findPixCodes(text: string, max = 5): PixCode[] {
  const flat = text.replace(/[\r\n]+/g, "");
  const found: PixCode[] = [];
  const seen = new Set<string>();
  for (let at = flat.indexOf("000201"); at !== -1 && found.length < max; ) {
    const end = payloadEnd(flat, at);
    const payload = end === -1 ? null : flat.slice(at, end);
    const code = payload && !seen.has(payload) ? parsePix(payload) : null;
    if (payload && code) {
      seen.add(payload);
      found.push(code);
    }
    at = flat.indexOf("000201", code && end !== -1 ? end : at + 1);
  }
  return found;
}
