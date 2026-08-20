import { describe, expect, it } from "vitest";
import { RESOURCE_SHEETS, type ResourceSheet } from "./api-sheet";
import { LANGS } from "./api-sheet-snippets";

const LOCALES = ["en", "pt-BR"] as const;

/** Walks "audience.contacts" → messages/<locale>/audience.json → .contacts. */
async function sheetMessages(locale: string, ns: string): Promise<Record<string, unknown>> {
  const [file, ...path] = ns.split(".") as [string, ...string[]];
  let node: Record<string, unknown> = (await import(`../../messages/${locale}/${file}.json`))
    .default;
  for (const key of path) node = node[key] as Record<string, unknown>;
  return node.apiSheet as Record<string, unknown>;
}

describe("RESOURCE_SHEETS", () => {
  for (const [resource, sheet] of Object.entries<ResourceSheet>(RESOURCE_SHEETS)) {
    for (const locale of LOCALES) {
      it(`${resource}: ${locale} carries apiSheet.title and every section heading`, async () => {
        const msgs = await sheetMessages(locale, sheet.ns);
        for (const key of ["title", ...sheet.sections]) {
          expect(msgs[key], `${locale}/${sheet.ns}.apiSheet.${key}`).toEqual(expect.any(String));
        }
      });
    }

    if (sheet.sdk) {
      const sdk = sheet.sdk;
      it(`${resource}: every emails-sheet language carries every section, with the placeholder key up front`, () => {
        for (const lang of LANGS) {
          for (const section of sheet.sections) {
            expect(sdk[lang][section], `${resource}.${lang}.${section}`).toEqual(
              expect.any(String),
            );
          }
          // Client setup convention: the first section constructs the client
          // with the placeholder key the keyHint tells users to replace.
          expect(sdk[lang][sheet.sections[0] ?? ""], `${resource}.${lang} setup`).toContain(
            "ms_xxxxxxxxx",
          );
        }
      });
    } else {
      it(`${resource}: every curl snippet is an authenticated call to the public API`, () => {
        for (const section of sheet.sections) {
          const code = sheet.curl[section];
          expect(code, `${resource}.${section}`).toContain("https://api.millionsend.com/");
          expect(code, `${resource}.${section}`).toContain("Authorization: Bearer ms_");
        }
      });
    }
  }
});
