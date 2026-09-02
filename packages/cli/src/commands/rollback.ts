import { RESOURCE_LABEL, ROLLBACK_ORDER } from "../apply.js";
import type { Context } from "../context.js";
import type { MillionSendTarget, WriteResult } from "../millionsend.js";
import type { MigrateState, Resource } from "../model.js";
import { migratePaths, readJson, STATE_DIR, writePrivateJson } from "../paths.js";
import { connectTarget, printHeader, TARGET_RPS } from "../session.js";
import { bold, dim, err, SYM } from "../theme.js";
import { confirmPrompt } from "../tty-ui.js";
import { capitalize, formatDuration, formatNumber, pluralize } from "../utils.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Deletes between two state writes; each write serialises the whole file. */
const SAVE_EVERY = 100;
const HEADER_TEXT =
  "Deletes what an earlier run created on your MillionSend instance; nothing on Resend is touched.";

const DELETE: Partial<
  Record<Resource, (target: MillionSendTarget, id: string) => Promise<WriteResult>>
> = {
  broadcasts: (t, id) => t.deleteBroadcast(id),
  templates: (t, id) => t.deleteTemplate(id),
  webhooks: (t, id) => t.deleteWebhook(id),
  contacts: (t, id) => t.deleteContact(id),
  segments: (t, id) => t.deleteSegment(id),
  topics: (t, id) => t.deleteTopic(id),
  properties: (t, id) => t.deleteProperty(id),
  domains: (t, id) => t.deleteDomain(id),
};

/** Deletes only the ids the state file says this tool created, in reverse dependency order. */
export async function rollback(ctx: Context): Promise<number> {
  const { config, out } = ctx;
  const paths = migratePaths(ctx.cwd);
  const state = readJson<MigrateState>(paths.state);
  const pending = ROLLBACK_ORDER.filter((r) => (state?.created[r]?.length ?? 0) > 0);
  const deleted: Partial<Record<Resource, number>> = {};
  const emitJson = (failures: MigrateState["failures"]): void => {
    if (config.json) ctx.stdout.write(`${JSON.stringify({ deleted, failures })}\n`);
  };
  if (state === null || pending.length === 0) {
    out.write(`Nothing to roll back: no ids created by this tool in ${STATE_DIR}/.\n`);
    emitJson([]);
    return 0;
  }
  // Ids reach the target as URL path segments; only what the API minted may be deleted.
  for (const resource of pending) {
    const bad = (state.created[resource] ?? []).filter((id) => !UUID.test(id)).length;
    if (bad > 0) {
      throw new Error(
        `${paths.state} lists ${pluralize(bad, "id")} under "${resource}" that are not MillionSend ids; the file was edited outside this tool. Fix or delete it, then run again.`,
      );
    }
  }
  printHeader(ctx, HEADER_TEXT);
  const { target, baseUrl } = await connectTarget(ctx);
  if (state.target.baseUrl !== baseUrl) {
    throw new Error(`${paths.state} belongs to ${state.target.baseUrl}; connected to ${baseUrl}.`);
  }
  out.write("\nThis deletes only what this tool created; rows it merely updated stay:\n");
  let requests = 0;
  for (const resource of pending) {
    const ids = state.created[resource] ?? [];
    requests += resource === "suppressions" ? Math.ceil(ids.length / 1000) : ids.length;
    out.write(
      `  ${bold(formatNumber(ids.length).padStart(8))}  ${RESOURCE_LABEL[resource]}${resource === "contacts" ? " (one request each)" : ""}\n`,
    );
    const rest = ids.length - 3;
    out.write(
      `${dim(`            ${ids.slice(0, 3).join(", ")}${rest > 0 ? ` … and ${formatNumber(rest)} more` : ""}`)}\n`,
    );
  }
  out.write(`${capitalize(formatDuration(requests / TARGET_RPS))} at ${TARGET_RPS} req/s.\n\n`);
  if (!config.yes) {
    if (config.nonInteractive) throw new Error("Rollback needs --yes in non-interactive mode.");
    if (!(await confirmPrompt(ctx.rl, { label: "Delete these from your MillionSend instance?" }))) {
      out.write("Nothing deleted.\n");
      emitJson([]);
      return 0;
    }
  }
  state.failures = [];
  ctx.progress.section(
    pending.map((r) => RESOURCE_LABEL[r]),
    pending.map((r) => {
      const n = formatNumber(state.created[r]?.length ?? 0);
      return `${n}/${n}`;
    }),
  );
  for (const resource of pending) {
    const ids = state.created[resource] ?? [];
    const remaining = new Set(ids);
    const save = (): void => {
      state.created[resource] = [...remaining];
      state.updatedAt = new Date().toISOString();
      writePrivateJson(paths.state, state);
    };
    const step = ctx.progress.step(RESOURCE_LABEL[resource]);
    let failed = 0;
    if (resource === "suppressions") {
      const { ids: removed, errors } = await target.removeSuppressions(ids);
      const kept = new Set<number>();
      for (const error of errors) {
        kept.add(error.index);
        failed += 1;
        state.failures.push({ resource, key: ids[error.index] ?? "?", message: error.message });
      }
      // A chunk that went through removed every id in it; rows already gone are not echoed back.
      for (const [i, id] of ids.entries()) if (!kept.has(i)) remaining.delete(id);
      step.update(removed.length, ids.length);
    } else {
      const del = DELETE[resource];
      for (const [n, id] of ids.entries()) {
        const result = del === undefined ? null : await del(target, id);
        if (result === null) break;
        if (result.ok || result.status === 404) remaining.delete(id);
        else {
          failed += 1;
          state.failures.push({ resource, key: id, message: result.message });
        }
        step.update(n + 1, ids.length);
        if ((n + 1) % SAVE_EVERY === 0) save();
      }
    }
    deleted[resource] = ids.length - remaining.size;
    // What a run resumed from no longer exists on the target.
    if (resource === "contacts") state.progress = {};
    save();
    if (failed > 0) step.fail(`${pluralize(failed, "delete")} failed`);
    else step.done();
  }
  emitJson(state.failures);
  if (state.failures.length > 0) {
    out.write(
      `\n${pluralize(state.failures.length, "delete")} failed; the ids stay in ${paths.state}:\n`,
    );
    for (const f of state.failures) {
      out.write(`  ${err(SYM.err)} ${f.resource}/${f.key} — ${f.message}\n`);
    }
    return 3;
  }
  out.write("\nRolled back. Rows this tool only updated were left as they are.\n");
  return 0;
}
