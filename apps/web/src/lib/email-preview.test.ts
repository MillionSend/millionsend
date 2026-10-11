import { describe, expect, it } from "vitest";
import { DARK_CLIENT_SIM, emulateEmailScheme, lockDownReceivedHtml } from "./email-preview";

describe("emulateEmailScheme", () => {
  const html =
    "<style>@media screen and (prefers-color-scheme: dark){body{background:#000}} @media (prefers-color-scheme: light){body{color:#111}}</style><p>hi</p>";

  it("switches the message's own dark rules on and its light rules off for a dark client", () => {
    const out = emulateEmailScheme(html, "dark");
    expect(out).toContain("@media screen and (min-width: 0px){body{background:#000}}");
    expect(out).toContain("@media (min-width: 999999px){body{color:#111}}");
    expect(out).toContain("color-scheme:dark");
    // The message handles dark itself; no auto-darkening on top.
    expect(out).not.toContain(DARK_CLIENT_SIM);
  });

  it("does the reverse for a light client", () => {
    const out = emulateEmailScheme(html, "light");
    expect(out).toContain("@media screen and (min-width: 999999px){body{background:#000}}");
    expect(out).toContain("@media (min-width: 0px){body{color:#111}}");
    expect(out).toContain("color-scheme:light");
  });

  it("auto-darkens a message with no dark treatment of its own, and only then", () => {
    expect(emulateEmailScheme("<p>plain</p>", "dark")).toContain(DARK_CLIENT_SIM);
    expect(emulateEmailScheme("<p>plain</p>", "light")).not.toContain(DARK_CLIENT_SIM);
    expect(
      emulateEmailScheme(
        '<meta name="supported-color-schemes" content="light dark"><p>x</p>',
        "dark",
      ),
    ).not.toContain(DARK_CLIENT_SIM);
  });
});

describe("lockDownReceivedHtml", () => {
  const POLICY = '<meta http-equiv="Content-Security-Policy"';

  it("puts a no-network policy ahead of everything a stranger wrote", () => {
    const doc = lockDownReceivedHtml(
      '<html><head><link rel="stylesheet" href="https://x.example/a.css"></head></html>',
    );
    expect(doc.startsWith(POLICY)).toBe(true);
    expect(doc).toContain("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    expect(doc).toContain('<meta name="referrer" content="no-referrer">');
  });

  it("keeps the message's doctype first, so its rendering mode stays as sent", () => {
    expect(
      lockDownReceivedHtml("<!DOCTYPE html>\n<html><body>hi</body></html>").startsWith(
        `<!DOCTYPE html>${POLICY}`,
      ),
    ).toBe(true);
  });
});
