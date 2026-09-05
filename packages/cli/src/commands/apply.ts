import { readFileSync } from "node:fs";
import type { Context } from "../context.js";
import { parsePlan, planHash } from "../plan.js";
import { confirmPrompt } from "../tty-ui.js";
import { formatDuration } from "../utils.js";
import { execute, migrate, prepare } from "./migrate.js";

const MAX_PLAN_AGE_MS = 3_600_000;

/**
 * Applies a saved plan (or plans and applies); exit 3 when some items failed.
 * A plan file holds no contacts, so the source is always read again; the
 * fresh plan is what gets applied, and the file is a checkpoint it must match.
 */
export async function apply(ctx: Context): Promise<number> {
  const { config, out } = ctx;
  if (config.planFile === null) return migrate(ctx);
  let text: string;
  try {
    text = readFileSync(config.planFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(
      `plan file ${config.planFile} not found; run \`migrate plan --from ${config.from ?? "resend"} --out ${config.planFile}\` first`,
    );
  }
  const saved = parsePlan(text);
  // Age needs no network: a stale file is refused before the source is read again.
  const ageMs = Date.now() - Date.parse(saved.createdAt);
  const stale = !(ageMs < MAX_PLAN_AGE_MS);
  if (stale && config.nonInteractive) {
    throw new Error(
      `${config.planFile} is ${formatDuration(ageMs / 1000)} old. Re-run \`migrate plan --out\`, or apply without a file.`,
    );
  }
  if (stale) {
    out.write(
      `${config.planFile} is ${formatDuration(ageMs / 1000)} old; reading the source again to build a current plan.\n`,
    );
  }
  const prepared = await prepare(ctx, config.from ?? saved.source);
  if (saved.target.baseUrl !== prepared.baseUrl) {
    throw new Error(
      `${config.planFile} was made for ${saved.target.baseUrl}; connected to ${prepared.baseUrl}.`,
    );
  }
  const reasons: string[] = [];
  if (stale) reasons.push(`is ${formatDuration(ageMs / 1000)} old`);
  if (planHash(saved) !== planHash(prepared.plan)) reasons.push("differs from the plan just built");
  if (reasons.length > 0) {
    const notice = `${config.planFile} ${reasons.join(" and ")}; the plan above is current.`;
    if (config.nonInteractive) {
      throw new Error(`${notice} Re-run \`migrate plan --out\`, or apply without a file.`);
    }
    out.write(`${notice}\n`);
    if (!(await confirmPrompt(ctx.rl, { label: "Apply the current plan instead?" }))) {
      out.write("Nothing applied.\n");
      return 0;
    }
  }
  return execute(ctx, prepared);
}
