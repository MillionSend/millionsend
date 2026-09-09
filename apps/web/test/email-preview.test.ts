import { describe, expect, it } from "vitest";
import { DARK_CLIENT_SIM, emulateEmailScheme } from "../src/lib/email-preview";

describe("emulateEmailScheme", () => {
  it("simulates a dark client by inverting a light rendering, so unstyled text stays readable", () => {
    const doc = emulateEmailScheme("<p>Plain text as sent</p>", "dark");
    expect(doc).toContain(DARK_CLIENT_SIM);
    expect(doc).toContain("color-scheme:light");
    expect(doc).not.toContain("color-scheme:dark");
  });

  it("lets a message with its own dark treatment render as dark without the simulation", () => {
    const html =
      "<style>@media (prefers-color-scheme: dark) { body { background: #000 } }</style><p>hi</p>";
    const doc = emulateEmailScheme(html, "dark");
    expect(doc).not.toContain(DARK_CLIENT_SIM);
    expect(doc).toContain("color-scheme:dark");
    expect(doc).toContain("min-width: 0px");
  });

  it("renders light as light", () => {
    const doc = emulateEmailScheme("<p>hi</p>", "light");
    expect(doc).toContain("color-scheme:light");
    expect(doc).not.toContain(DARK_CLIENT_SIM);
  });
});

it("sends every link to the viewer's own browser, from the head when the message has one", () => {
  const withHead = emulateEmailScheme(
    '<html><head><title>x</title></head><body><a href="https://x.example">go</a></body></html>',
    "light",
  );
  expect(withHead.startsWith('<html><head><base target="_blank"><title>x</title>')).toBe(true);
  expect(
    emulateEmailScheme("<p>bare</p>", "dark").startsWith('<base target="_blank"><p>bare</p>'),
  ).toBe(true);
});
