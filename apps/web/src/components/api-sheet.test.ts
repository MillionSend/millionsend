import { describe, expect, it } from "vitest";
import { RESOURCE_SHEETS } from "./api-sheet";

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
  for (const [resource, { ns, sections }] of Object.entries(RESOURCE_SHEETS)) {
    for (const locale of LOCALES) {
      it(`${resource}: ${locale} carries apiSheet.title and every section heading`, async () => {
        const msgs = await sheetMessages(locale, ns);
        for (const key of ["title", ...sections.map(([section]) => section)]) {
          expect(msgs[key], `${locale}/${ns}.apiSheet.${key}`).toEqual(expect.any(String));
        }
      });
    }

    it(`${resource}: every snippet is an authenticated call to the public API`, () => {
      for (const [section, code] of sections) {
        expect(code, `${resource}.${section}`).toContain("https://api.millionsend.com/");
        expect(code, `${resource}.${section}`).toContain("Authorization: Bearer ms_");
      }
    });
  }
});
