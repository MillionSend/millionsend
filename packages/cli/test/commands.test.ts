import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enrichmentItem } from "../src/apply.js";
import { main } from "../src/index.js";
import type { MigrateState, Plan, SourceContact } from "../src/model.js";
import { migratePaths, writePrivateJson } from "../src/paths.js";
import type { Report } from "../src/report.js";
import { type FakeResend, startFakeResend } from "./helpers/fake-resend.js";
import { type LiveApi, startLiveApi } from "./helpers/live-api.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const SLOW = 120_000;

let fake: FakeResend;
let api: LiveApi;
let cwd: string;

function collector() {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += String(chunk);
      callback();
    },
  });
  return {
    stream,
    get text() {
      return text;
    },
  };
}

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    RESEND_API_KEY: fake.token,
    MILLIONSEND_CLI_RESEND_URL: fake.url,
    MILLIONSEND_API_KEY: api.apiKey,
    MILLIONSEND_BASE_URL: api.baseUrl,
    ...extra,
  };
}

async function run(
  argv: string[],
  options: { cwd?: string; env?: Record<string, string>; stdin?: string } = {},
) {
  const input = new PassThrough();
  input.end(options.stdin ?? "");
  const stdout = collector();
  const stderr = collector();
  const code = await main(argv, {
    stdin: input,
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: env(options.env),
    cwd: options.cwd ?? cwd,
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

const readState = (dir = cwd): MigrateState | null => {
  const path = migratePaths(dir).state;
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as MigrateState) : null;
};
const readReport = (dir = cwd): Report =>
  JSON.parse(readFileSync(migratePaths(dir).reportJson, "utf8")) as Report;

async function apiList<T>(path: string, key = api.apiKey): Promise<T[]> {
  const response = await fetch(`${api.baseUrl}${path}?limit=100`, {
    headers: { authorization: `Bearer ${key}` },
  });
  return ((await response.json()) as { data: T[] }).data;
}

function exec(
  command: string,
  args: string[],
  dir: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: dir, env: environment, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Nothing that could open either account may reach a file or a stream. */
function expectNoSecrets(...texts: string[]): void {
  for (const text of texts) {
    expect(text).not.toContain(fake.token);
    expect(text).not.toContain(api.apiKey);
    expect(text).not.toContain("whsec_");
  }
}

beforeAll(async () => {
  // main() runs in-process with color mode auto: the host shell's FORCE_COLOR would paint every transcript.
  delete process.env.FORCE_COLOR;
  [fake, api] = await Promise.all([
    startFakeResend(),
    startLiveApi({ isCloud: true, appBaseUrl: "https://app.example.test" }),
  ]);
  cwd = mkdtempSync(join(tmpdir(), "millionsend-cli-"));
  writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
});
afterAll(async () => {
  await Promise.all([fake.close(), api.stop()]);
});

describe("millionsend migrate", () => {
  it("rejects a bad source key with exit 1 and names the env var", async () => {
    const { code, stderr } = await run(["migrate", "--from", "resend", "--yes"], {
      env: { RESEND_API_KEY: "re_wrong_1234567890abcdef" },
    });
    expect(code).toBe(1);
    expect(stderr).toContain("RESEND_API_KEY");
    expect(readState()).toBeNull();
  });

  it("refuses to apply without --yes when stdin is not a terminal", async () => {
    const { code, stderr } = await run(["migrate", "--from", "resend"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--yes");
    expect(readState()).toBeNull();
  });

  it(
    "moves the fixture account, keeps every key out of files and output",
    async () => {
      const { code, stdout, stderr } = await run(["migrate", "--from", "resend", "--yes"]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toContain("✓ Resend · connected");
      expect(stdout).toContain("✓ MillionSend Cloud · plan Free");
      expect(stdout).toContain("Plan: ");
      expect(stdout).toContain("Resend was only read; nothing there was changed.");
      expect(stdout).toContain("contacts created");
      expect(stdout).toContain("Added .millionsend/ to .gitignore.");
      expect(stdout).toContain("add DNS records for news.example.com");
      expect(stdout).toContain("create API keys: Production, Staging");
      expect(stdout).toContain(
        "On Resend you sent 41,208 emails in the last 30 days (~1,374/day).",
      );
      expect(stdout.replace(/\n/g, " ")).toContain(
        "Free allows 100/day; Pro (3,000/day, 20 domains) fits.",
      );
      expect(stdout).toContain("https://app.example.test/settings/billing");
      expect(stdout).toContain("again right before cutover");
      expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe("node_modules\n.millionsend/\n");
      expect(fake.writes).toBe(0);

      const state = readState();
      expect(state).not.toBeNull();
      const created = state?.created ?? {};
      expect(Object.fromEntries(Object.entries(created).map(([k, v]) => [k, v.length]))).toEqual({
        properties: 2,
        topics: 2,
        segments: 1,
        domains: 2,
        webhooks: 1,
        templates: 1,
        contacts: 3,
        suppressions: 3,
      });
      expect(state?.progress.contactsCursor).toBeNull();
      expect(state?.progress.enrichmentDone).toBeUndefined();
      expect(state?.failures).toEqual([]);

      const paths = migratePaths(cwd);
      for (const path of [paths.state, paths.reportJson, paths.reportMd]) {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
      const report = readReport();
      expect(report.counts.contacts).toMatchObject({ created: 3, failed: 0 });
      // grace has no properties and no topic subscriptions: nothing to send for her.
      expect(report.counts.enrichment?.updated).toBe(2);
      expect(report.dns.map((d) => d.domain).sort()).toEqual(["example.com", "news.example.com"]);
      expect(report.dns[0]?.records.some((r) => r.record === "DKIM")).toBe(true);
      expect(report.apiKeys).toEqual(["Production", "Staging"]);
      expect(report.offer?.fits).toBe("pro");
      expect(report.freshWebhookSecrets).toEqual([]);
      const md = readFileSync(paths.reportMd, "utf8");
      expect(md).toContain("### DNS records for example.com");
      expect(md).toContain("Resend is a trademark of Plus Five Five, Inc.");
      expectNoSecrets(
        stdout,
        stderr,
        readFileSync(paths.state, "utf8"),
        readFileSync(paths.reportJson, "utf8"),
        md,
      );

      const contacts = await apiList<{ id: string; email: string; unsubscribed: boolean }>(
        "/contacts",
      );
      expect(contacts.map((c) => c.email).sort()).toEqual([
        "ada@example.org",
        "grace@example.net",
        "steve.wozniak@gmail.com",
      ]);
      expect(contacts.find((c) => c.email === "ada@example.org")?.unsubscribed).toBe(true);
      const steve = contacts.find((c) => c.email === "steve.wozniak@gmail.com");
      const detail = (await (
        await fetch(`${api.baseUrl}/contacts/${steve?.id}`, {
          headers: { authorization: `Bearer ${api.apiKey}` },
        })
      ).json()) as { properties: Record<string, unknown> };
      expect(detail.properties).toEqual({
        plan: { type: "string", value: "pro" },
        seats: { type: "number", value: 5 },
      });
      const suppressions = await apiList<{ email: string; origin: string }>("/suppressions");
      expect(suppressions.map((s) => [s.email, s.origin]).sort()).toEqual([
        ["blocked@example.org", "manual"],
        ["bounced@example.org", "bounce"],
        ["complained@example.org", "complaint"],
      ]);
    },
    SLOW,
  );

  it(
    "status prints what was created",
    async () => {
      const { code, stdout } = await run(["migrate", "status"]);
      expect(code).toBe(0);
      expect(stdout).toContain(api.baseUrl);
      expect(stdout).toMatch(/Contacts\s+3/);
      expect(stdout).toMatch(/Enriched\s+complete/);
    },
    SLOW,
  );

  it(
    "a second run leaves everything unchanged and keeps the same ids",
    async () => {
      const before = readState();
      const { code, stdout } = await run(["migrate", "--from", "resend", "--yes"]);
      expect(code).toBe(0);
      expect(stdout).toContain("topics\n  = Product updates");
      expect(readState()?.created).toEqual(before?.created);
      const report = readReport();
      expect(report.counts.topics).toMatchObject({ created: 0, unchanged: 2 });
      expect(report.counts.domains).toMatchObject({ created: 0, unchanged: 2 });
      expect(report.counts.contacts).toMatchObject({ created: 0, updated: 3 });
      expect(report.counts.suppressions).toMatchObject({ created: 0, unchanged: 3 });
      expect(await apiList("/topics")).toHaveLength(2);
    },
    SLOW,
  );

  it(
    "plan exits 2 with changes, 0 when nothing to do, and writes --out",
    async () => {
      const out = join(cwd, "plan.json");
      const changes = await run(["migrate", "plan", "--from", "resend", "--out", out]);
      expect(changes.code).toBe(2);
      expect(changes.stdout).toContain("contacts (3)\n  + contacts  batch upsert");
      const plan = JSON.parse(readFileSync(out, "utf8")) as Plan;
      expect(plan.version).toBe(1);
      expect(plan.target.baseUrl).toBe(api.baseUrl);
      expect(JSON.stringify(plan)).not.toContain("whsec_");

      const nothing = await run(["migrate", "plan", "--from", "resend", "--only", "topics"]);
      expect(nothing.code).toBe(0);
      expect(nothing.stdout).toContain("Plan: 0 to create, 0 to update, 2 unchanged, 0 manual.");
    },
    SLOW,
  );

  it(
    "apply refuses a stale plan file non-interactively",
    async () => {
      const out = join(cwd, "old-plan.json");
      const { stdout: _ } = await run(["migrate", "plan", "--from", "resend", "--out", out]);
      const stale = JSON.parse(readFileSync(out, "utf8")) as Plan;
      stale.createdAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
      writeFileSync(out, JSON.stringify(stale));
      const { code, stderr } = await run(["migrate", "apply", out, "--yes"]);
      expect(code).toBe(1);
      expect(stderr).toContain("old");
    },
    SLOW,
  );

  it(
    "--json puts only JSON on stdout and syncs a topic added since the first run",
    async () => {
      fake.data.topics.push({
        id: "d1e2f3a4-0000-4000-8000-000000000001",
        name: "Changelog",
        default_subscription: "opt_in",
        visibility: "public",
        created_at: "2026-09-01 00:00:00.000+00",
      });
      const planRun = await run([
        "migrate",
        "plan",
        "--from",
        "resend",
        "--json",
        "--only",
        "topics",
      ]);
      expect(planRun.code).toBe(2);
      expect((JSON.parse(planRun.stdout) as Plan).counts.create).toBe(1);

      const { code, stdout, stderr } = await run([
        "migrate",
        "--from",
        "resend",
        "--json",
        "--yes",
        "--only",
        "topics",
      ]);
      fake.data.topics.pop();
      expect(code).toBe(0);
      const report = JSON.parse(stdout) as Report;
      expect(report.counts.topics).toMatchObject({ created: 1, unchanged: 2 });
      expect(stderr).toMatch(/✓ Topics\s+1\/1/);
      expect(readState()?.created.topics).toHaveLength(3);
    },
    SLOW,
  );

  it(
    "a failed item is exit 3, listed, and does not stop the run",
    async () => {
      fake.data.contacts.push({
        id: "00000000-0000-4000-8000-00000000bad1",
        email: "not-an-email",
        created_at: "2026-09-01 00:00:00.000+00",
        unsubscribed: false,
      });
      const { code, stdout } = await run([
        "migrate",
        "--from",
        "resend",
        "--yes",
        "--only",
        "contacts",
      ]);
      fake.data.contacts.pop();
      expect(code).toBe(3);
      expect(stdout).toContain("✗ Contacts — 1 of 4 failed");
      expect(stdout).toContain("contacts/not-an-email");
      const state = readState();
      expect(state?.failures).toEqual([
        { resource: "contacts", key: "not-an-email", message: expect.stringMatching(/email/) },
      ]);
      expect(state?.created.contacts).toHaveLength(3);
      expect(readReport().failures).toHaveLength(1);
    },
    SLOW,
  );

  it(
    "an auth failure mid-apply is exit 1 with the state saved",
    async () => {
      const other = await startLiveApi({ isCloud: false, slug: "auth" });
      const dir = mkdtempSync(join(tmpdir(), "millionsend-cli-auth-"));
      try {
        const steve = fake.data.contacts[0]?.id ?? "";
        fake.injectOnce(`/contacts/${steve}`, {
          status: 401,
          body: { name: "invalid_api_key", message: "revoked" },
        });
        const { code, stderr } = await run(["migrate", "--from", "resend", "--yes"], {
          cwd: dir,
          env: { MILLIONSEND_API_KEY: other.apiKey, MILLIONSEND_BASE_URL: other.baseUrl },
        });
        expect(code).toBe(1);
        expect(stderr).toContain("Resend rejected the API key (401)");
        const state = readState(dir);
        expect(state?.created.contacts).toHaveLength(3);
        expect(state?.created.topics).toHaveLength(2);
        expect(state?.progress.enrichmentDone ?? []).toHaveLength(0);
      } finally {
        await other.stop();
      }
    },
    SLOW,
  );

  it(
    "rollback deletes exactly what the tool created and nothing else",
    async () => {
      const state = readState();
      expect(state?.created.contacts).toHaveLength(3);
      const { code, stdout } = await run(["migrate", "rollback", "--yes"]);
      expect(code).toBe(0);
      expect(stdout).toContain("Rolled back.");
      const after = readState();
      expect(Object.values(after?.created ?? {}).every((ids) => ids.length === 0)).toBe(true);
      for (const path of [
        "/contacts",
        "/topics",
        "/segments",
        "/contact-properties",
        "/domains",
        "/webhooks",
        "/templates",
        "/suppressions",
      ]) {
        expect(await apiList(path), path).toEqual([]);
      }
      const again = await run(["migrate", "rollback", "--yes"]);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain("Nothing to roll back");
    },
    SLOW,
  );

  it(
    "the built bundle runs as a subprocess",
    async () => {
      const bundle = join(PACKAGE_DIR, "dist", "index.js");
      const result = await exec(
        process.execPath,
        [bundle, "migrate", "plan", "--from", "resend"],
        cwd,
        {
          ...process.env,
          ...env(),
          NO_COLOR: "1",
        },
      );
      expect(result.stderr).toBe("");
      expect(result.code).toBe(2);
      const { version: packageVersion } = JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ) as { version: string };
      expect(result.stdout).toContain(
        `millionsend ${packageVersion} — Moves your Resend account into MillionSend.`,
      );
      expect(result.stdout).toContain("contacts (3)\n  + contacts  batch upsert");
      expect(result.stdout).toContain("Estimate: ~");
      expectNoSecrets(result.stdout, result.stderr);
      const version = await exec(process.execPath, [bundle, "--version"], cwd);
      expect(version.stdout.trim()).toBe(packageVersion);
    },
    SLOW,
  );
});

describe("enrichmentItem", () => {
  const maps = {
    propertyKeys: new Set(["plan"]),
    topicBySource: new Map([["src-news", "tgt-news"]]),
  };
  const contact: SourceContact = {
    id: "c1",
    email: "ada@example.org",
    firstName: null,
    lastName: null,
    unsubscribed: false,
    createdAt: "",
    properties: { plan: "pro", unknown: "dropped" },
    topics: [
      { id: "src-news", subscription: "opt_in" },
      { id: "src-missing", subscription: "opt_out" },
    ],
  };

  it("sends every mapped subscription for a contact created this run", () => {
    expect(enrichmentItem(contact, "created", maps)).toEqual({
      email: "ada@example.org",
      properties: { plan: "pro" },
      topics: [{ id: "tgt-news", subscription: "opt_in" }],
    });
  });

  it("sends only opt-outs for a contact that already existed, so target opt-outs survive", () => {
    expect(enrichmentItem(contact, "updated", maps)).toEqual({
      email: "ada@example.org",
      properties: { plan: "pro" },
    });
    const optedOut = { ...contact, topics: [{ id: "src-news", subscription: "opt_out" as const }] };
    expect(enrichmentItem(optedOut, "updated", maps).topics).toEqual([
      { id: "tgt-news", subscription: "opt_out" },
    ]);
  });
});

describe("migrate rollback", () => {
  const rejectJson = () =>
    new Response(JSON.stringify({ name: "validation_error", message: "rejected for the test" }), {
      status: 422,
      headers: { "content-type": "application/json" },
    });

  async function runWithFetch(argv: string[], dir: string, fetchFn: typeof fetch) {
    const input = new PassThrough();
    input.end("");
    const stdout = collector();
    const stderr = collector();
    const code = await main(argv, {
      stdin: input,
      stdout: stdout.stream,
      stderr: stderr.stream,
      env: env(),
      cwd: dir,
      fetch: fetchFn,
    });
    return { code, stdout: stdout.text, stderr: stderr.text };
  }

  it("refuses a state file whose ids are not MillionSend ids before connecting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "millionsend-cli-rb-"));
    const state: MigrateState = {
      version: 1,
      startedAt: "",
      updatedAt: "",
      planHash: "",
      target: { baseUrl: api.baseUrl },
      created: {
        templates: ["welcome"],
        topics: ["../domains/00000000-0000-4000-8000-000000000000"],
      },
      progress: {},
      failures: [],
    };
    writePrivateJson(migratePaths(dir).state, state);
    const { code, stdout, stderr } = await run(["migrate", "rollback", "--yes"], { cwd: dir });
    expect(code).toBe(1);
    expect(stderr).toContain(`${migratePaths(dir).state} lists 1 id under "templates"`);
    expect(stderr).toContain("not MillionSend ids");
    expect(stdout).not.toContain("✓ MillionSend");
    expect(stdout).not.toContain("welcome");
  });

  it(
    "prints its own header and the first ids, writes a JSON summary, and clears the resume cursor",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "millionsend-cli-rb-"));
      const extra = ["one", "two"].map((n, i) => ({
        id: `00000000-0000-4000-8000-00000000000${i + 1}`,
        email: `${n}@example.org`,
        created_at: "2026-09-01 00:00:00.000+00",
        unsubscribed: false,
      }));
      fake.data.contacts.push(...extra);
      try {
        const migrated = await run(["migrate", "--from", "resend", "--yes", "--only", "contacts"], {
          cwd: dir,
        });
        expect(migrated.code).toBe(0);
      } finally {
        fake.data.contacts.splice(-extra.length);
      }
      const before = readState(dir);
      const ids = before?.created.contacts ?? [];
      expect(ids).toHaveLength(5);
      if (before === null) throw new Error("no state");
      // What an interrupted enrichment leaves behind.
      before.progress = { contactsCursor: ids[0], enrichmentDone: [ids[0] ?? ""] };
      writePrivateJson(migratePaths(dir).state, before);

      const { code, stdout, stderr } = await run(["migrate", "rollback", "--yes", "--json"], {
        cwd: dir,
      });
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ deleted: { contacts: 5 }, failures: [] });
      // The plain header wraps at the layout width (80 here) with a hanging indent.
      expect(stderr).toContain(
        "— Deletes what an earlier run created on your MillionSend\n  instance; nothing on Resend is touched.\n",
      );
      expect(stderr).not.toContain("Reads only");
      expect(stderr).toContain(`${ids.slice(0, 3).join(", ")} … and 2 more`);
      expect(readState(dir)?.progress).toEqual({});
      expect(readState(dir)?.created.contacts).toEqual([]);
      expect(await apiList("/contacts")).toEqual([]);

      const empty = await run(["migrate", "rollback", "--yes", "--json"], { cwd: dir });
      expect(empty.code).toBe(0);
      expect(JSON.parse(empty.stdout)).toEqual({ deleted: {}, failures: [] });
      expect(empty.stderr).toContain("Nothing to roll back");
    },
    SLOW,
  );

  it(
    "keeps suppression ids in the state when the batch remove fails",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "millionsend-cli-rb-"));
      const migrated = await run(
        ["migrate", "--from", "resend", "--yes", "--only", "suppressions"],
        { cwd: dir },
      );
      expect(migrated.code).toBe(0);
      expect(readState(dir)?.created.suppressions).toHaveLength(3);

      const rejectRemove: typeof fetch = (url, init) =>
        String(url).endsWith("/suppressions/batch/remove")
          ? Promise.resolve(rejectJson())
          : fetch(url, init);
      const failedRun = await runWithFetch(["migrate", "rollback", "--yes"], dir, rejectRemove);
      expect(failedRun.code).toBe(3);
      expect(failedRun.stdout).toContain("the ids stay in");
      expect(readState(dir)?.created.suppressions).toHaveLength(3);
      expect(readState(dir)?.failures).toHaveLength(3);

      const again = await run(["migrate", "rollback", "--yes"], { cwd: dir });
      expect(again.code).toBe(0);
      expect(readState(dir)?.created.suppressions).toEqual([]);
      expect(await apiList("/suppressions")).toEqual([]);
    },
    SLOW,
  );

  it(
    "retries failed enrichment on the next run, clears the cursor when it completes, never re-subscribes",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "millionsend-cli-rb-"));
      const argv = [
        "migrate",
        "--from",
        "resend",
        "--yes",
        "--only",
        "properties,topics,contacts,enrichment",
      ];
      // Pass 1 items carry `unsubscribed`; enrichment items never do.
      const rejectEnrichment: typeof fetch = (url, init) => {
        if (String(url).includes("/contacts/batch") && init?.method === "POST") {
          const items = JSON.parse(String(init.body)) as { unsubscribed?: boolean }[];
          if (items.every((i) => i.unsubscribed === undefined))
            return Promise.resolve(rejectJson());
        }
        return fetch(url, init);
      };
      const first = await runWithFetch(argv, dir, rejectEnrichment);
      expect(first.code).toBe(3);
      expect(readReport(dir).counts.enrichment?.failed).toBe(2);
      // grace had nothing to send and counts as done; the two failed ids are not skipped next time.
      expect(readState(dir)?.progress.enrichmentDone).toEqual([
        "f0e1d2c3-b4a5-4968-8776-655443322110",
      ]);

      const contacts = await apiList<{ id: string; email: string }>("/contacts");
      const steve = contacts.find((c) => c.email === "steve.wozniak@gmail.com");
      const topics = await apiList<{ id: string; name: string }>("/topics");
      const product = topics.find((t) => t.name === "Product updates");
      const patched = await fetch(`${api.baseUrl}/contacts/${steve?.id}/topics`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${api.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify([{ id: product?.id, subscription: "opt_out" }]),
      });
      expect(patched.status).toBe(200);

      const second = await run(argv, { cwd: dir });
      expect(second.code).toBe(0);
      expect(second.stdout).toContain("resuming: skipping 1 contact enriched in an earlier run");
      expect(readReport(dir).counts.enrichment).toMatchObject({ updated: 2, failed: 0 });
      expect(readState(dir)?.progress.enrichmentDone).toBeUndefined();
      const rows = await api.db
        .select({
          topicId: schema.contactTopicSubscriptions.topicId,
          subscribed: schema.contactTopicSubscriptions.subscribed,
        })
        .from(schema.contactTopicSubscriptions)
        .where(eq(schema.contactTopicSubscriptions.contactId, steve?.id ?? ""));
      expect(rows.find((r) => r.topicId === product?.id)?.subscribed).toBe(false);
      expect(rows.filter((r) => r.subscribed)).toEqual([]);

      const cleanup = await run(["migrate", "rollback", "--yes"], { cwd: dir });
      expect(cleanup.code).toBe(0);
    },
    SLOW,
  );
});

describe("plan, apply and status edge cases (own target)", () => {
  let mine: LiveApi;
  beforeAll(async () => {
    mine = await startLiveApi({ isCloud: false, slug: "edges" });
  });
  afterAll(() => mine.stop());

  const target = () => ({ MILLIONSEND_API_KEY: mine.apiKey, MILLIONSEND_BASE_URL: mine.baseUrl });
  const freshDir = () => mkdtempSync(join(tmpdir(), "millionsend-cli-edge-"));
  const seed = (dir: string, partial: Partial<MigrateState>): MigrateState => {
    const state: MigrateState = {
      version: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      planHash: "stale",
      target: { baseUrl: mine.baseUrl },
      created: {},
      progress: {},
      failures: [],
      ...partial,
    };
    writePrivateJson(migratePaths(dir).state, state);
    return state;
  };

  it(
    "plan exits 0 and migrate --json still prints a report when only manual items remain",
    async () => {
      const dir = freshDir();
      const planRun = await run(["migrate", "plan", "--from", "resend", "--only", "api-keys"], {
        cwd: dir,
        env: target(),
      });
      expect(planRun.code).toBe(0);
      expect(planRun.stdout).toContain("Plan: 0 to create, 0 to update, 0 unchanged, 2 manual.");
      // The source host is printed whenever it is not api.resend.com.
      expect(planRun.stdout).toContain(`✓ Resend · connected (${fake.url})`);

      const json = await run(
        ["migrate", "--from", "resend", "--json", "--yes", "--only", "api-keys"],
        { cwd: dir, env: target() },
      );
      expect(json.code).toBe(0);
      expect(json.stderr).toContain("Nothing to do.");
      const report = JSON.parse(json.stdout) as Report;
      expect(report.counts["api-keys"]).toEqual({
        created: 0,
        updated: 0,
        unchanged: 0,
        skipped: 0,
        manual: 2,
        failed: 0,
      });
      expect(report.apiKeys).toEqual(["Production", "Staging"]);
      expect(report.checklist.left).toContain("create API keys: Production, Staging");
      expect(existsSync(migratePaths(dir).state)).toBe(false);
    },
    SLOW,
  );

  it("refuses to send the Resend key to the MillionSend host, before connecting", async () => {
    const { code, stdout, stderr } = await run(["migrate", "plan", "--from", "resend"], {
      cwd: freshDir(),
      env: { ...target(), MILLIONSEND_CLI_RESEND_URL: mine.baseUrl },
    });
    expect(code).toBe(1);
    expect(stderr).toContain("is the MillionSend host");
    expect(stderr).toContain("MILLIONSEND_CLI_RESEND_URL");
    expect(stderr).toContain("MILLIONSEND_BASE_URL");
    expect(stdout).not.toContain("✓ Resend");
  });

  it("a missing plan file says how to make one", async () => {
    const file = join(freshDir(), "plan.json");
    const { code, stderr } = await run(["migrate", "apply", file, "--yes"], { env: target() });
    expect(code).toBe(1);
    expect(stderr).toContain(
      `plan file ${file} not found; run \`migrate plan --from resend --out ${file}\` first`,
    );
  });

  it(
    "declining the stale-plan prompt is exit 0, like declining the apply prompt",
    async () => {
      const dir = freshDir();
      const file = join(dir, "plan.json");
      await run(["migrate", "plan", "--from", "resend", "--only", "topics", "--out", file], {
        cwd: dir,
        env: target(),
      });
      const stale = JSON.parse(readFileSync(file, "utf8")) as Plan;
      stale.createdAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
      writeFileSync(file, JSON.stringify(stale));
      // A terminal on stdin makes the run interactive; the prompt reads the piped "n".
      const input = new PassThrough() as PassThrough & { isTTY?: boolean };
      input.isTTY = true;
      input.end("n\n");
      const stdout = collector();
      const stderr = collector();
      const code = await main(["migrate", "apply", file, "--only", "topics"], {
        stdin: input,
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: env(target()),
        cwd: dir,
      });
      expect(stderr.text).toBe("");
      expect(code).toBe(0);
      expect(stdout.text).toContain(`${file} is about 120 min old; the plan above is current.`);
      expect(stdout.text).toContain("Nothing applied.");
      expect(existsSync(migratePaths(dir).state)).toBe(false);
    },
    SLOW,
  );

  it(
    "--fresh forgets the resume cursor but keeps what earlier runs created",
    async () => {
      const dir = freshDir();
      const seeded = seed(dir, {
        created: { contacts: ["00000000-0000-4000-8000-0000000000aa"] },
        progress: { contactsCursor: "x", enrichmentDone: ["y"], suppressionsDone: true },
      });
      const { code } = await run(
        ["migrate", "--from", "resend", "--yes", "--fresh", "--only", "topics"],
        { cwd: dir, env: target() },
      );
      expect(code).toBe(0);
      const after = readState(dir);
      expect(after?.startedAt).toBe(seeded.startedAt);
      expect(after?.created.contacts).toEqual(seeded.created.contacts);
      expect(after?.created.topics).toHaveLength(2);
      expect(after?.progress.enrichmentDone).toBeUndefined();
      expect(after?.progress.suppressionsDone).toBeUndefined();
      expect(after?.progress.contactsCursor ?? null).toBeNull();
    },
    SLOW,
  );

  it("status strips control sequences from failure lines", async () => {
    const dir = freshDir();
    seed(dir, {
      failures: [{ resource: "topics", key: "News\x1b[2J", message: "bad\x1b]52;c;x\x07 row" }],
    });
    const { code, stdout } = await run(["migrate", "status"], { cwd: dir });
    expect(code).toBe(0);
    expect(stdout).toContain("✗ topics/News — bad row");
    expect(stdout).not.toContain("\x1b");
    expect(stdout).not.toContain("\x07");
  });
});

describe("cutover-first run shape", () => {
  it(
    "prints the connected limit, the cutover block before enrichment, and per-pass counts",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "millionsend-cli-cut-"));
      // A full run: the cutover-ready block presumes contacts, domains and suppressions came along.
      const result = await run(["migrate", "--from", "resend", "--yes"], { cwd: dir });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("limit 10 req/s, using 8");
      const cutover = result.stdout.indexOf("Cutover ready");
      const topicsPass = result.stdout.indexOf("Enrichment · topics");
      const propertiesPass = result.stdout.indexOf("Enrichment · properties");
      expect(cutover).toBeGreaterThan(-1);
      expect(topicsPass).toBeGreaterThan(cutover);
      expect(propertiesPass).toBeGreaterThan(topicsPass);
      expect(result.stdout).toContain("set RESEND_BASE_URL=");
      expect(result.stdout).toMatch(/with topic subscriptions/);
      expect(result.stdout).toMatch(/with properties/);
      const report = readReport(dir);
      expect(report.enrichment?.withProperties).toBeGreaterThan(0);
      expect(report.enrichment?.withTopics).toBeGreaterThan(0);
      expect(readState(dir)?.progress.topicsDone).toBeUndefined();

      // The target now holds the contacts: enrichment can run on its own.
      const again = await run(["migrate", "--from", "resend", "--yes", "--only", "enrichment"], {
        cwd: dir,
      });
      expect(again.code).toBe(0);
      expect(again.stdout).toContain("Enrichment · topics");
      expect(again.stdout).not.toContain("Nothing to do");
    },
    SLOW,
  );

  it(
    "runs the properties pass alone when topics are left out of the include set",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "millionsend-cli-props-"));
      // The contacts must already be on the target for enrichment to plan on its own.
      expect(
        (await run(["migrate", "--from", "resend", "--yes", "--only", "contacts"], { cwd: dir }))
          .code,
      ).toBe(0);
      fake.requests.length = 0;
      const result = await run(
        ["migrate", "--from", "resend", "--yes", "--only", "properties,enrichment"],
        { cwd: dir },
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Enrichment · topics: skipped, topics not migrated");
      expect(result.stdout).toMatch(/Enrichment · properties .*with properties/);
      expect(
        fake.requests.some((r) => r.path.endsWith("/topics") && r.path.startsWith("/contacts/")),
      ).toBe(false);
      const report = readReport(dir);
      expect(report.enrichment?.withTopics).toBe(0);
      expect(report.enrichment?.withProperties).toBeGreaterThan(0);
    },
    SLOW,
  );

  it(
    "creates a contact that appeared since the last run with its unsubscribed flag, and records it for rollback",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "millionsend-cli-signup-"));
      expect(
        (await run(["migrate", "--from", "resend", "--yes", "--only", "contacts"], { cwd: dir }))
          .code,
      ).toBe(0);
      const contacts = fake.data.contacts as { id: string }[];
      const newcomer = {
        id: "0f0f0f0f-1111-4222-8333-444455556666",
        email: "newcomer@example.net",
        first_name: "New",
        last_name: "Comer",
        created_at: "2026-09-05 16:00:22+00",
        unsubscribed: true,
        properties: { plan: "free" },
        topics: [],
      };
      contacts.push(newcomer);
      try {
        const result = await run(
          ["migrate", "--from", "resend", "--yes", "--only", "properties,enrichment"],
          { cwd: dir },
        );
        expect(result.code).toBe(0);
        expect(result.stdout).not.toContain("Cutover ready");
        expect(result.stdout).toContain("not a cutover");
        const onTarget = await apiList<{ id: string; email: string; unsubscribed: boolean }>(
          "/contacts",
        );
        const created = onTarget.find((c) => c.email === newcomer.email);
        expect(created?.unsubscribed).toBe(true);
        expect(readState(dir)?.created.contacts).toEqual([created?.id]);
        expect(readReport(dir).counts.contacts).toMatchObject({ created: 1 });
      } finally {
        contacts.splice(
          contacts.findIndex((c) => c.id === newcomer.id),
          1,
        );
      }
    },
    SLOW,
  );

  it(
    "refuses a stale plan file before reading the source again",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "millionsend-cli-stale-"));
      const planFile = join(dir, "plan.json");
      const planned = await run(
        ["migrate", "plan", "--from", "resend", "--only", "topics", "--out", planFile],
        { cwd: dir },
      );
      expect([0, 2]).toContain(planned.code);
      const saved = JSON.parse(readFileSync(planFile, "utf8")) as { createdAt: string };
      saved.createdAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
      writeFileSync(planFile, JSON.stringify(saved));
      fake.requests.length = 0;
      const applied = await run(["migrate", "apply", planFile, "--yes", "--non-interactive"], {
        cwd: dir,
      });
      expect(applied.code).not.toBe(0);
      expect(applied.stderr).toMatch(/is about 3 h old|is about 180 min old|old\./);
      expect(fake.requests).toHaveLength(0);
    },
    SLOW,
  );
});
