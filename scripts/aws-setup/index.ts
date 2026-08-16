// Entry for `pnpm setup:aws` (repo clone on the operator's machine) and the
// container's `setup` argv mode in scripts/start.mjs. Run under tsx, which
// resolves the ".js" specifier to the .ts source. The relative import (not
// "@millionsend/ses") keeps this runnable from the workspace root, where the
// package name does not resolve; the AWS SDK deps resolve from packages/ses.
import { main } from "../../packages/ses/src/setup-cli.js";

// exitCode (not process.exit) so piped stdout flushes before the process ends.
main().then((code) => {
  process.exitCode = code;
});
