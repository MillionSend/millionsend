import { expect, it } from "vitest";

// Static imports hoist above these assignments; the config env is read at
// import time, so the client must be loaded after the environment is set.
process.env.SKIP_ENV_VALIDATION = "1";
process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:1/unused";
const { getDb } = await import("../src/client.js");

// A raw Date in a sql`` template is inferred as timestamptz (1184) by the
// driver and must arrive as text; drizzle's own column-mapped strings must
// not be re-parsed (a naive timestamp without zone would shift to local time).
it("serializes a raw Date param as ISO text and passes strings through", () => {
  const { serializers } = getDb().$client.options;
  expect(serializers[1184]?.(new Date(0))).toBe("1970-01-01T00:00:00.000Z");
  expect(serializers[1184]?.("2026-01-01 10:00:00")).toBe("2026-01-01 10:00:00");
});
