// Usage (from packages/cli so tsx resolves the workspace):
//   SKIP_ENV_VALIDATION=1 pnpm exec tsx <PREVIEW>/capture.mjs [before|after]... [--only id,id]
// Records every scenario for each build under a pty (pty-run.py) against a
// fresh fake Resend + cloud + self-hosted API per build, then writes
// out/<build>/<id>.{ansi,txt,html} and scenarios.json.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeResend } from "../../test/helpers/fake-resend.ts";
import { startLiveApi } from "../../test/helpers/live-api.ts";
import { fakeId, realisticAccount } from "../../test/helpers/realistic-account.ts";
import { toHtml } from "./ansi-to-html.mjs";
import { screen } from "./vt.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const OUT = join(HERE, "out");
const PTY = join(HERE, "pty-run.py");
const BUNDLE = {
  before: join(HERE, "before-pkg/package/dist/index.js"),
  after: join(HERE, "../../dist/index.js"),
};
// Prompts that wait for a keypress under a tty; Enter takes their defaults.
const ENTER_ON = ["enter confirms", "Domain limit\r"];
const MIGRATE = ["migrate", "--from", "resend", "--yes", "--rps", "10"];
const BAD_KEY = "re_invalid_key_000000";

const argv = process.argv.slice(2);
const onlyIds = argv.includes("--only") ? argv[argv.indexOf("--only") + 1].split(",") : null;
const builds = argv.filter((a) => a in BUNDLE);
if (builds.length === 0) builds.push("before", "after");

const freshCwd = (tag) => {
  const cwd = mkdtempSync(join(tmpdir(), `millionsend-preview-${tag}-`));
  writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
  return cwd;
};

const cwdCounter = { n: 0 };
function makeEnv(fake, cloud, extra = {}) {
  const env = {
    ...process.env,
    RESEND_API_KEY: fake.token,
    MILLIONSEND_CLI_RESEND_URL: fake.url,
    RESEND_BASE_URL: fake.url,
    MILLIONSEND_API_KEY: cloud.apiKey,
    MILLIONSEND_BASE_URL: cloud.baseUrl,
  };
  for (const k of ["NO_COLOR", "FORCE_COLOR", "COLUMNS", "LINES"]) delete env[k];
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function runPty({ bundle, args, cwd, env, cols = 100, rows = 50 }) {
  const child = spawn(
    "python3",
    [
      PTY,
      String(cols),
      String(rows),
      ...ENTER_ON.flatMap((m) => ["--enter-on", m]),
      "--",
      process.execPath,
      bundle,
      ...args,
    ],
    { cwd, env, stdio: ["ignore", "pipe", "inherit"] },
  );
  const chunks = [];
  child.stdout.on("data", (c) => chunks.push(c));
  return new Promise((resolve) =>
    child.on("close", (code) => resolve({ code, out: Buffer.concat(chunks) })),
  );
}

const echo = (args) => Buffer.from(`$ millionsend ${args.join(" ")}\r\n`);

/*
 * Order matters: the cloud instance is shared for a build. Read-only
 * scenarios first; migrate/status/rollback share a cwd; resume runs last
 * because it leaves rows behind.
 */
const SCENARIOS = [
  {
    id: "help",
    title: "Help",
    args: ["--help"],
    notes:
      "Command grammar, flags and the trademark line; AFTER documents --color <mode> and FORCE_COLOR (no banner on --help in either build).",
  },
  {
    id: "plan",
    title: "Plan (read-only)",
    args: ["migrate", "plan", "--from", "resend"],
    notes:
      "Connect lines, the read progress, the resource picker, and the plan table with manual items and the domain-cap warning.",
  },
  {
    id: "narrow",
    title: "Plan at 60 columns",
    args: ["migrate", "plan", "--from", "resend"],
    cols: 60,
    notes: "The compact banner tier and how the plan wraps in a narrow terminal.",
  },
  {
    id: "badkey",
    title: "Rejected Resend key",
    args: ["migrate", "plan", "--from", "resend"],
    env: { RESEND_API_KEY: BAD_KEY },
    notes: "The exit-1 message for a 401 from Resend, before anything is read.",
  },
  {
    id: "selfhost",
    title: "Self-hosted target",
    args: [...MIGRATE, "--to-url", "SELF_URL", "--skip", "enrichment"],
    self: true,
    notes: "Neutral copy for a self-hosted instance: no plan name, no upgrade offer.",
  },
  {
    id: "migrate",
    title: "Full migration",
    args: MIGRATE,
    cwd: "shared",
    notes:
      "The whole run: prompts, applying progress at 10 req/s with enrichment, and the summary with the to-do list, id map and DNS records.",
  },
  {
    id: "status",
    title: "Status",
    args: ["migrate", "status"],
    cwd: "shared",
    notes:
      "What the saved state says after a completed run; AFTER adds the State heading and bold counts.",
  },
  {
    id: "rollback",
    title: "Rollback",
    args: ["migrate", "rollback", "--yes"],
    cwd: "shared",
    notes:
      "Deleting only what the tool created; the estimate line and the final note about updated rows.",
  },
  {
    id: "resume",
    title: "Interrupted and resumed",
    args: MIGRATE,
    resume: true,
    notes:
      "A 401 from Resend mid-enrichment exits 1 with the state saved; the same command again picks up where it stopped.",
  },
];

const results = {};
for (const build of builds) {
  const bundle = BUNDLE[build];
  console.log(`\n=== ${build}: ${bundle}`);
  const [fake, cloud, self] = await Promise.all([
    startFakeResend(realisticAccount()),
    startLiveApi({ isCloud: true, appBaseUrl: "https://app.example.test", slug: "cloud" }),
    // A self-hosted instance has APP_BASE_URL set: without it the API refuses
    // the domains' tracking settings and the run exits 3 with two failed items.
    startLiveApi({ isCloud: false, appBaseUrl: "https://mail.example.test", slug: "self" }),
  ]);
  const api = async (path, body) => {
    const r = await fetch(`${cloud.baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${cloud.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
    return r.json();
  };
  // Same seed as the e2e: a verified sender, an unrelated domain, a topic that differs.
  await api("/domains", { name: "example.com" });
  await cloud.db.execute("update domains set status = 'verified'");
  await api("/domains", { name: "legacy.example.net" });
  await api("/topics", {
    name: "Newsletter",
    description: "Old description",
    default_subscription: "opt_out",
  });

  const dir = join(OUT, build);
  mkdirSync(dir, { recursive: true });
  const shared = freshCwd(`${build}-shared`);
  results[build] = {};

  for (const s of SCENARIOS) {
    if (onlyIds && !onlyIds.includes(s.id)) continue;
    const started = Date.now();
    const cwd = s.cwd === "shared" ? shared : freshCwd(`${build}-${s.id}-${cwdCounter.n++}`);
    const env = makeEnv(
      fake,
      cloud,
      s.self
        ? { MILLIONSEND_API_KEY: self.apiKey, MILLIONSEND_BASE_URL: undefined, ...s.env }
        : s.env,
    );
    const args = s.args.map((a) => (a === "SELF_URL" ? self.baseUrl : a));
    const parts = [];
    const codes = [];
    if (s.resume) {
      fake.injectOnce(`/contacts/${fakeId(5, 5)}`, {
        status: 401,
        body: { name: "invalid_api_key", message: "API key is invalid" },
      });
      const first = await runPty({ bundle, args, cwd, env });
      parts.push(echo(args), first.out, Buffer.from("\r\n"));
      codes.push(first.code);
      const second = await runPty({ bundle, args, cwd, env });
      parts.push(echo(args), second.out);
      codes.push(second.code);
    } else {
      const run = await runPty({ bundle, args, cwd, env, cols: s.cols });
      parts.push(run.out);
      codes.push(run.code);
    }
    const ansi = Buffer.concat(parts);
    writeFileSync(join(dir, `${s.id}.ansi`), ansi);
    const txt = screen(ansi.toString("utf8"));
    writeFileSync(join(dir, `${s.id}.txt`), `${txt}\n`);
    writeFileSync(join(dir, `${s.id}.html`), toHtml(txt));
    results[build][s.id] = {
      codes,
      bytes: ansi.length,
      seconds: Math.round((Date.now() - started) / 1000),
    };
    console.log(
      `${build}/${s.id}: exit ${codes.join(",")}, ${ansi.length} bytes, ${results[build][s.id].seconds}s`,
    );
  }
  await Promise.all([fake.close(), cloud.stop(), self.stop()]);
}

const shown = (s) => {
  const cmd = `millionsend ${s.args.map((a) => (a === "SELF_URL" ? "http://127.0.0.1:<port>" : a)).join(" ")}`;
  const envPrefix = s.self
    ? "MILLIONSEND_API_KEY=<self-hosted key> "
    : s.env?.RESEND_API_KEY
      ? `RESEND_API_KEY=${BAD_KEY} `
      : "";
  return s.resume ? `${cmd}\n${cmd}` : `${envPrefix}${cmd}`;
};
writeFileSync(
  join(HERE, "scenarios.json"),
  `${JSON.stringify(
    SCENARIOS.map((s) => ({
      id: s.id,
      title: s.title,
      command: shown(s),
      notes: s.notes,
      before: { html: `out/before/${s.id}.html`, cols: s.cols ?? 100 },
      after: { html: `out/after/${s.id}.html`, cols: s.cols ?? 100 },
    })),
    null,
    2,
  )}\n`,
);
writeFileSync(join(OUT, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log("\ndone");
process.exit(0);
