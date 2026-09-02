import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apply } from "./commands/apply.js";
import { migrate } from "./commands/migrate.js";
import { plan } from "./commands/plan.js";
import { rollback } from "./commands/rollback.js";
import { status } from "./commands/status.js";
import { type Config, ConfigError, helpText, parseConfig } from "./config.js";
import { type Context, createContext, type Io } from "./context.js";
import { VERSION } from "./meta.js";

const COMMANDS: Record<
  Exclude<Config["command"], "help" | "version">,
  (ctx: Context) => Promise<number>
> = { migrate, plan, apply, status, rollback };

/** The CLI as a function: the tests run it in-process with their own streams, env and cwd. */
export async function main(argv = process.argv.slice(2), io: Io = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  let config: Config;
  try {
    config = parseConfig(argv, io.env ?? process.env, (io.stdin ?? process.stdin).isTTY === true);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    stderr.write(`${error.message}\n`);
    return 1;
  }
  if (config.command === "help") {
    stdout.write(helpText());
    return 0;
  }
  if (config.command === "version") {
    stdout.write(`${VERSION}\n`);
    return 0;
  }
  const ctx = createContext(config, io);
  for (const warning of config.warnings) ctx.log.warn(warning);
  try {
    return await COMMANDS[config.command](ctx);
  } catch (error) {
    ctx.progress.clear();
    ctx.log.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    ctx.rl.close();
  }
}

const invokedAsScript = (): boolean => {
  try {
    return (
      process.argv[1] !== undefined &&
      realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
};

if (invokedAsScript()) {
  // exitCode (not process.exit) so piped stdout flushes before the process ends.
  main().then((code) => {
    process.exitCode = code;
  });
}
