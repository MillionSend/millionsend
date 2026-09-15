import {
  boolean,
  doublePrecision,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * One health sample per probe per minute, written by the worker's probe cron
 * and read back as history by the operator console. `value` is the probe's
 * number (a latency, a count, a rate) or null when the probe only says ok/not
 * ok. Rows past the console's history window are pruned by the retention cron.
 */
export const instanceProbes = pgTable(
  "instance_probes",
  {
    probe: text("probe").notNull(),
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull(),
    value: doublePrecision("value"),
    ok: boolean("ok").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.probe, t.takenAt] }),
    // The prune deletes by age across every probe.
    index("instance_probes_taken_at_idx").on(t.takenAt),
  ],
);
