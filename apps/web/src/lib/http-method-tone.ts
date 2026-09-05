/**
 * Badge tone per HTTP method, following Postman's palette — the one developers
 * already read: GET green, POST yellow, PUT blue, PATCH purple, DELETE red,
 * HEAD green, OPTIONS pink. Tones name `.ms-badge-*` classes and `--ms-*` tokens.
 */
export type HttpMethodTone = "success" | "warn" | "info" | "violet" | "danger" | "pink" | "neutral";

const TONES: Record<string, HttpMethodTone> = {
  GET: "success",
  POST: "warn",
  PUT: "info",
  PATCH: "violet",
  DELETE: "danger",
  HEAD: "success",
  OPTIONS: "pink",
};

export const httpMethodTone = (method: string): HttpMethodTone =>
  TONES[method.toUpperCase()] ?? "neutral";
