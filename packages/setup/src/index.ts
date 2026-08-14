// Entry for the published `millionsend-setup` bin. esbuild bundles this into
// dist/index.js, inlining the CLI source from packages/ses (the relative
// import, not "@millionsend/ses", so the published tool and the in-repo
// `pnpm setup:aws` stay one codebase) while @aws-sdk/* remain regular
// dependencies resolved at install time.
import { main } from "../../ses/src/setup-cli.js";

// exitCode (not process.exit) so piped stdout flushes before the process ends.
main().then((code) => {
  process.exitCode = code;
});
