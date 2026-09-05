import {
  type ApplyOutcome,
  applyPlan,
  type Counts,
  ENRICHMENT_LABEL,
  RESOURCE_LABEL,
} from "../apply.js";
import type { Context } from "../context.js";
import type { MillionSendTarget } from "../millionsend.js";
import {
  type MigrateState,
  type Plan,
  type ProviderId,
  RESOURCES,
  type Resource,
  type Snapshot,
  type TargetState,
  type TargetUsage,
} from "../model.js";
import { ensureGitignored, migratePaths, readJson, writePrivateJson } from "../paths.js";
import { buildPlan, capDomainCreates, planHash, renderPlan } from "../plan.js";
import type { Provider, Source } from "../providers/index.js";
import { providers } from "../providers/index.js";
import { buildReport, printSummary, type Report, writeReport } from "../report.js";
import {
  bridgeProgress,
  connectSource,
  connectTarget,
  includeSet,
  printHeader,
} from "../session.js";
import { heading } from "../theme.js";
import { confirmPrompt, multiSelectPrompt, selectPrompt } from "../tty-ui.js";
import { formatNumber, pluralize } from "../utils.js";

export interface Prepared {
  provider: Provider;
  source: Source;
  target: MillionSendTarget;
  usage: TargetUsage;
  baseUrl: string;
  snapshot: Snapshot;
  targetState: TargetState;
  plan: Plan;
  include: ReadonlySet<Resource>;
}

type PickerOption = { label: string; hint?: string };

function pickerOption(
  resource: Resource,
  snapshot: Snapshot,
  includeSent: boolean,
): PickerOption | null {
  const n = (count: number, noun: string): PickerOption | null =>
    count === 0 ? null : { label: `${noun} ${formatNumber(count)}` };
  switch (resource) {
    case "domains":
      return n(snapshot.domains.length, "Domains");
    case "properties":
      return n(snapshot.properties.length, "Contact properties");
    case "topics":
      return n(snapshot.topics.length, "Topics");
    case "segments":
      return n(snapshot.segments.length, "Segments");
    case "contacts":
      return n(snapshot.contacts.length, "Contacts");
    case "enrichment":
      return snapshot.contacts.length > 0 &&
        (snapshot.properties.length > 0 || snapshot.topics.length > 0)
        ? {
            label: `Enrichment ${formatNumber(snapshot.contacts.length)}`,
            hint: "properties and topic subscriptions, read per contact",
          }
        : null;
    case "broadcasts": {
      const sent = snapshot.broadcasts.filter((b) => b.status === "sent").length;
      const drafts = snapshot.broadcasts.length - sent;
      if (snapshot.broadcasts.length === 0) return null;
      return {
        label: `Broadcasts ${pluralize(drafts, "draft")} · ${formatNumber(sent)} sent${includeSent || sent === 0 ? "" : " (not selected)"}`,
        ...(sent > 0 && !includeSent
          ? { hint: "--include-sent imports sent broadcasts as drafts" }
          : {}),
      };
    }
    case "templates":
      return n(snapshot.templates.length, "Templates");
    case "webhooks":
      return n(snapshot.webhooks.length, "Webhooks");
    case "suppressions":
      return n(snapshot.suppressions.length, "Suppressions");
    case "api-keys":
      return snapshot.apiKeys.length === 0
        ? null
        : {
            label: `API keys ${formatNumber(snapshot.apiKeys.length)}`,
            hint: "names only, listed as a to-do",
          };
  }
}

async function pickResources(
  ctx: Context,
  snapshot: Snapshot,
  include: Set<Resource>,
): Promise<Set<Resource>> {
  const options = RESOURCES.filter((r) => include.has(r)).flatMap((resource) => {
    const option = pickerOption(resource, snapshot, ctx.config.includeSent);
    return option === null ? [] : [{ value: resource, ...option, checked: true }];
  });
  if (options.length === 0) return new Set();
  const values = await multiSelectPrompt(ctx.rl, { label: "Resources", options });
  return new Set(values as Resource[]);
}

/** The plan's domain cap: create the first N and list the rest as manual, or stop. */
async function resolveDomainLimit(ctx: Context, plan: Plan, target: TargetState): Promise<Plan> {
  const limit = target.usage.limits.domains;
  const creates = plan.items.filter((i) => i.resource === "domains" && i.action === "create");
  if (limit === null || creates.length === 0 || target.domains.length + creates.length <= limit) {
    return plan;
  }
  const allowed = Math.max(0, limit - target.domains.length);
  const first =
    allowed === 0
      ? "Skip the domains and list them as manual"
      : `Create the first ${pluralize(allowed, "domain")} and list the rest as manual`;
  let choice: string;
  if (ctx.config.command === "plan") {
    // Read-only: nothing to stop, and the saved plan must equal what `apply --yes` builds.
    choice = "first";
  } else if (ctx.config.nonInteractive) {
    // parseConfig already required --yes for this command.
    choice = "first";
  } else {
    choice = await selectPrompt(ctx.rl, {
      label: "Domain limit",
      options: [
        { value: "first", label: first },
        { value: "stop", label: "Stop" },
      ],
    });
  }
  if (choice !== "first") throw new Error("Stopped at the domain limit; nothing was applied.");
  ctx.out.write(
    `${formatNumber(allowed)} of ${formatNumber(creates.length)} domains will be created; the rest are listed as manual.\n`,
  );
  return capDomainCreates(plan, allowed);
}

/** Steps 1-5: header, connect both sides, read, choose resources, plan. */
export async function prepare(ctx: Context, providerId: ProviderId): Promise<Prepared> {
  const { config, out } = ctx;
  const label = providers[providerId].label;
  printHeader(
    ctx,
    `Moves your ${label} account into MillionSend. Reads only; nothing on ${label} is changed.`,
  );
  const { provider, source } = await connectSource(ctx, providerId);
  const { target, usage, baseUrl } = await connectTarget(ctx);
  const include = includeSet(config);
  out.write(`\n${heading(`Reading ${label}`)}\n`);
  ctx.progress.section([...[...include].map((r) => RESOURCE_LABEL[r]), "MillionSend"]);
  const snapshot = await source.readShallow({
    include,
    includeSent: config.includeSent,
    onProgress: bridgeProgress(ctx.progress),
  });
  if (usage.cloud) snapshot.metrics = await source.readMetrics();
  const step = ctx.progress.step("MillionSend");
  const targetState = await target.readState();
  step.done("current state read");
  const chosen =
    config.nonInteractive || config.only !== null || config.skip.length > 0
      ? include
      : await pickResources(ctx, snapshot, include);
  let plan = buildPlan({
    snapshot,
    target: targetState,
    options: {
      include: chosen,
      includeSent: config.includeSent,
      freshWebhookSecrets: config.freshWebhookSecrets,
      rps: config.rps,
      sourceRequestsSpent: source.requests,
      baseUrl,
    },
  });
  out.write(`\n${heading("Plan")}\n`);
  out.write(renderPlan(plan));
  plan = await resolveDomainLimit(ctx, plan, targetState);
  return { provider, source, target, usage, baseUrl, snapshot, targetState, plan, include: chosen };
}

/** Manual items are listed, not counted: a converged migration must exit 0 even with API keys to recreate. */
export const hasChanges = (plan: Plan): boolean => plan.counts.create + plan.counts.update > 0;

function newState(baseUrl: string, hash: string): MigrateState {
  const now = new Date().toISOString();
  return {
    version: 1,
    startedAt: now,
    updatedAt: now,
    planHash: hash,
    target: { baseUrl },
    created: {},
    progress: {},
    failures: [],
  };
}

function loadState(ctx: Context, baseUrl: string, hash: string): MigrateState {
  const paths = migratePaths(ctx.cwd);
  const existing = readJson<MigrateState>(paths.state);
  if (existing === null) return newState(baseUrl, hash);
  if (existing.target.baseUrl !== baseUrl) {
    // Ids created on another instance are useless here; --fresh starts over for this one.
    if (ctx.config.fresh) return newState(baseUrl, hash);
    throw new Error(
      `${paths.state} belongs to ${existing.target.baseUrl}; run from another directory or pass --fresh.`,
    );
  }
  // --fresh forgets only where the last run stopped; `created` stays so rollback still works.
  if (ctx.config.fresh) existing.progress = {};
  // A different plan means a different contact list: the batch cursor no longer points anywhere.
  if (existing.planHash !== hash) existing.progress.contactsCursor = null;
  existing.planHash = hash;
  existing.failures = [];
  return existing;
}

/** What applyPlan tallies for a plan with nothing to write: unchanged, manual and skipped items. */
function idleOutcome(plan: Plan, state: MigrateState): ApplyOutcome {
  const counts: Counts = {};
  for (const item of plan.items) {
    const c = counts[item.resource] ?? {
      created: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      manual: 0,
      failed: 0,
    };
    counts[item.resource] = c;
    if (item.action === "unchanged") c.unchanged += 1;
    else if (item.action === "manual") c.manual += 1;
    else if (item.action === "skip") c.skipped += 1;
  }
  return {
    state,
    counts,
    freshSecrets: [],
    domainRecords: {},
    ids: [],
    enrichment: { withProperties: 0, withTopics: 0 },
  };
}

const runReport = (prepared: Prepared, outcome: ApplyOutcome): Report =>
  buildReport({
    plan: prepared.plan,
    snapshot: prepared.snapshot,
    outcome,
    usage: prepared.usage,
    targetState: prepared.targetState,
    baseUrl: prepared.baseUrl,
    sourceLabel: prepared.provider.label,
  });

/** Steps 6-7: confirm, apply, report. Exit 0, 3 when some items failed. */
export async function execute(ctx: Context, prepared: Prepared): Promise<number> {
  const { config, out } = ctx;
  const { plan } = prepared;
  const hash = planHash(plan);
  if (!hasChanges(plan)) {
    out.write("Nothing to do.\n");
    // A --json consumer still gets a document on stdout, not an empty pipe.
    if (config.json) {
      const idle = runReport(prepared, idleOutcome(plan, newState(prepared.baseUrl, hash)));
      ctx.stdout.write(`${JSON.stringify(idle, null, 2)}\n`);
    }
    return 0;
  }
  if (!config.yes && !(await confirmPrompt(ctx.rl, { label: "Apply this plan?" }))) {
    out.write("Nothing applied.\n");
    return 0;
  }
  const paths = migratePaths(ctx.cwd);
  const state = loadState(ctx, prepared.baseUrl, hash);
  const save = (s: MigrateState): void => writePrivateJson(paths.state, s);
  save(state);
  if (ensureGitignored(ctx.cwd)) out.write("Added .millionsend/ to .gitignore.\n");
  out.write(`\n${heading("Applying")}\n`);
  // Per-resource write totals, so the `n/total` counters share a right edge.
  const totals = new Map<Resource, number>();
  for (const i of plan.items) {
    if (i.action === "create" || i.action === "update")
      totals.set(i.resource, (totals.get(i.resource) ?? 0) + (i.count ?? 1));
  }
  ctx.progress.section(
    [...totals.keys()].flatMap((r) =>
      r === "enrichment" ? Object.values(ENRICHMENT_LABEL) : [RESOURCE_LABEL[r]],
    ),
    [...totals.values()].map((n) => `${formatNumber(n)}/${formatNumber(n)}`),
  );
  const outcome = await applyPlan({
    plan,
    include: prepared.include,
    snapshot: prepared.snapshot,
    source: prepared.source,
    target: prepared.target,
    state,
    onConflict: config.onConflict,
    progress: ctx.progress,
    log: ctx.log,
    save,
  });
  const report = runReport(prepared, outcome);
  writeReport(paths, report, config.report);
  if (config.json) {
    ctx.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    await printSummary(out, report);
  }
  out.write(`\nReport: ${paths.reportMd} (and .json)\n`);
  return outcome.state.failures.length > 0 ? 3 : 0;
}

/** Interactive end to end: connect → choose resources → plan → confirm → apply → summary. */
export async function migrate(ctx: Context): Promise<number> {
  const providerId = ctx.config.from ?? "resend";
  return execute(ctx, await prepare(ctx, providerId));
}
