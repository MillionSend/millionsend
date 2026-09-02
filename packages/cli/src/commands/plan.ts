import { writeFileSync } from "node:fs";
import type { Context } from "../context.js";
import { serializePlan } from "../plan.js";
import { hasChanges, prepare } from "./migrate.js";

/** Read-only plan; exit 0 nothing to do, 2 changes, 1 error. */
export async function plan(ctx: Context): Promise<number> {
  const prepared = await prepare(ctx, ctx.config.from ?? "resend");
  const json = serializePlan(prepared.plan);
  if (ctx.config.out !== null) {
    writeFileSync(ctx.config.out, json);
    ctx.out.write(`Plan written to ${ctx.config.out}\n`);
  }
  if (ctx.config.json) ctx.stdout.write(json);
  return hasChanges(prepared.plan) ? 2 : 0;
}
