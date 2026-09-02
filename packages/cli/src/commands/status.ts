import { RESOURCE_LABEL } from "../apply.js";
import type { Context } from "../context.js";
import type { MigrateState, Resource } from "../model.js";
import { migratePaths, readJson, STATE_DIR } from "../paths.js";
import { bold, column, err, heading, SYM } from "../theme.js";
import { formatNumber, pluralize, stripControl } from "../utils.js";

/** What the last run created and what is left, from the state file. */
export async function status(ctx: Context): Promise<number> {
  const paths = migratePaths(ctx.cwd);
  const state = readJson<MigrateState>(paths.state);
  if (ctx.config.json) {
    ctx.stdout.write(`${JSON.stringify(state)}\n`);
    return 0;
  }
  const { out } = ctx;
  if (state === null) {
    out.write(`No migration state in ${STATE_DIR}/ — nothing has been applied from here.\n`);
    return 0;
  }
  const block = (rows: readonly (readonly [string, string])[]): void => {
    out.write(`${column(rows).join("\n")}\n`);
  };
  out.write(`${heading("State")}\n`);
  block([
    ["Target", state.target.baseUrl],
    ["Started", state.startedAt],
    ["Updated", state.updatedAt],
    ["Plan", state.planHash.slice(0, 12)],
  ]);
  out.write("\nCreated\n");
  const created = Object.entries(state.created).filter(([, ids]) => ids.length > 0);
  if (created.length === 0) out.write("  nothing\n");
  else
    block(
      created.map(([resource, ids]) => [
        `  ${RESOURCE_LABEL[resource as Resource] ?? resource}`,
        bold(formatNumber(ids.length)),
      ]),
    );
  const { contactsCursor, enrichmentDone } = state.progress;
  out.write("\nProgress\n");
  block([
    ["  Contacts", contactsCursor ? `resumes after ${contactsCursor}` : "complete"],
    [
      "  Enriched",
      enrichmentDone ? `resumes with ${formatNumber(enrichmentDone.length)} done` : "complete",
    ],
  ]);
  if (state.failures.length > 0) {
    out.write(`\n${pluralize(state.failures.length, "failure")} in the last run\n`);
    for (const f of state.failures)
      out.write(`  ${err(SYM.err)} ${stripControl(`${f.resource}/${f.key} — ${f.message}`)}\n`);
  }
  return 0;
}
