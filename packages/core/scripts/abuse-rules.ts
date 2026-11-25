// Detection rules file tool.
//   check <file>  validate a rules file; exit 1 with the failing paths
//   defaults      print the built-in rules as JSON, a starting file
// Run from packages/core: tsx scripts/abuse-rules.ts check ./abuse-rules.json
// The tool reads no instance config, so it needs none of the env set.
process.env.SKIP_ENV_VALIDATION ??= "1";
const { DEFAULT_ABUSE_RULES, loadAbuseRulesFile } = await import("../src/abuse-rules.js");

const [command, file] = process.argv.slice(2);

if (command === "defaults") {
  process.stdout.write(`${JSON.stringify(DEFAULT_ABUSE_RULES, null, 2)}\n`);
} else if (command === "check" && file) {
  try {
    const rules = loadAbuseRulesFile(file);
    console.log(`ok: ${rules.version}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
} else {
  console.error("usage: abuse-rules.ts check <file> | defaults");
  process.exit(2);
}
