// Entry for `pnpm setup:aws` (repo clone on the operator's machine) and the
// container's `setup` argv mode in scripts/start.mjs. Run under tsx, which
// resolves the ".js" specifier to the .ts source. The relative import (not
// "@millionsend/ses") keeps this runnable from the workspace root, where the
// package name does not resolve; the AWS SDK deps resolve from packages/ses.
import { main } from "../../packages/ses/src/setup-cli.js";
import { socialLoginStep } from "./social-login.js";

// exitCode (not process.exit) so piped stdout flushes before the process ends.
main().then(async (code) => {
  process.exitCode = code;
  // Social login rides after the wizard: env-only, no AWS, defaults to skip.
  // Its failures never mask the wizard's exit code.
  if (code === 0 && process.argv[2] !== "teardown" && !process.argv.includes("--dry-run")) {
    try {
      await socialLoginStep();
    } catch (error) {
      console.error(`Social login step failed: ${(error as Error).message}`);
    }
  }
});
