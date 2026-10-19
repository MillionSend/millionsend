import { mailPreferenceOf } from "@millionsend/core/mail-preferences";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createCaller } from "@/server/routers";
import en from "../messages/en/settings.json";
import ptBR from "../messages/pt-BR/settings.json";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(schema.user).values({ id: "u1", name: "u1", email: "u1@example.com" });
});
afterEach(() => close());

it("every notice starts on; a switch turned off twice is off once, and turning it back on leaves the others", async () => {
  const teamId = await createTeam(db, "acme");
  const caller = createCaller({
    db,
    session: { user: { id: "u1", email: "u1@example.com", name: "u1" } },
    teamId,
    role: "owner",
  });
  const prefs = caller.settings.mailPreferences;
  expect(await prefs.get()).toEqual({ optOuts: [] });
  expect(await prefs.set({ key: "broadcast.sent", enabled: false })).toEqual({
    optOuts: ["broadcast.sent"],
  });
  await prefs.set({ key: "broadcast.sent", enabled: false });
  await prefs.set({ key: "quota", enabled: false });
  expect((await prefs.get()).optOuts.sort()).toEqual(["broadcast.sent", "quota"]);
  expect(await prefs.set({ key: "broadcast.sent", enabled: true })).toEqual({ optOuts: ["quota"] });
  // Mail that is always sent has no switch to turn.
  await expect(prefs.set({ key: "api_key.created" as never, enabled: false })).rejects.toBeTruthy();
});

it("the deliverability switch's note names the warm-up mail it also covers", () => {
  expect(mailPreferenceOf("warmup.paused")).toBe("deliverability");
  expect(mailPreferenceOf("warmup.done")).toBe("deliverability");
  expect(en.notifications.items.deliverability.note).toContain("warm-up paused or done");
  expect(ptBR.notifications.items.deliverability.note).toContain("aquecimento");
});
