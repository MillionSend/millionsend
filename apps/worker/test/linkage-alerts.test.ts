import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, expect, it } from "vitest";
import { alertLinkedTeams } from "../src/handlers/linkage-alerts.js";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db
    .insert(schema.user)
    .values({ id: "op", name: "Operator", email: "op@example.com", createdAt: new Date(0) });
});
afterAll(() => close());

it("mails the operator once per link, naming the kinds of evidence and never the values", async () => {
  const teamId = await createTeam(db, "newcomer");
  await db.insert(schema.teamLinks).values({
    teamId,
    linkedTeamId: crypto.randomUUID(),
    linkedTeamName: "facture-vexto",
    matches: [
      { kind: "display_name", value: "Facture Vexto", matched: "Facture Vexto" },
      {
        kind: "sending_domain",
        value: "cadeaux-vexto.example",
        matched: "vexto-cadeaux.example",
      },
      { kind: "phone", value: "123456789", matched: "123456789" },
    ],
    trigger: "send",
    held: true,
  });
  const mails: { to: string; kind: string; text: string }[] = [];
  const deps = {
    mailer: {
      send: async (to: string, m: { kind: string; text: string }) =>
        void mails.push({ to, kind: m.kind, text: m.text }),
    },
    appBaseUrl: "https://app.example.test",
  };
  expect(await alertLinkedTeams(db, deps)).toBe(1);
  expect(await alertLinkedTeams(db, deps)).toBe(0);
  expect(mails).toMatchObject([{ to: "op@example.com", kind: "monitor.team_linked" }]);
  const text = mails[0]?.text ?? "";
  expect(text).toContain(
    "newcomer matches facture-vexto, a team you suspended for phishing, on its sender name, domain name, and phone number.",
  );
  expect(text).toContain("It is held for review: its mail waits until you decide");
  expect(text).toContain(`https://app.example.test/console/safety/${teamId}`);
  for (const value of ["Facture Vexto", "cadeaux-vexto", "123456789"]) {
    expect(text).not.toContain(value);
  }
});
