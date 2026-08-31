import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../messages", import.meta.url));

function keysOf(node: unknown, prefix = ""): string[] {
  if (typeof node !== "object" || node === null) return [prefix];
  return Object.entries(node).flatMap(([key, value]) =>
    keysOf(value, prefix ? `${prefix}.${key}` : key),
  );
}

describe("i18n catalog parity", () => {
  const files = readdirSync(join(root, "en"));

  it("both locales carry the same namespace files", () => {
    expect(readdirSync(join(root, "pt-BR")).sort()).toEqual([...files].sort());
  });

  for (const file of files) {
    it(`${file}: en and pt-BR carry the same keys`, () => {
      const load = (locale: string): unknown =>
        JSON.parse(readFileSync(join(root, locale, file), "utf8"));
      expect(keysOf(load("pt-BR")).sort()).toEqual(keysOf(load("en")).sort());
    });
  }
});
