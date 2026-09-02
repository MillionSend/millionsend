import type { ApplyOutcome, Counts, IdMapping, ResourceCounts } from "./apply.js";
import type { OutStream } from "./context.js";
import { CLOUD_BILLING_URL, TRADEMARK_NOTICE } from "./meta.js";
import {
  type DnsRecord,
  type MigrateState,
  type Plan,
  type PlanItem,
  type ProviderId,
  RESOURCES,
  type Resource,
  type Snapshot,
  type TargetState,
  type TargetUsage,
} from "./model.js";
import { type MigratePaths, writePrivate, writePrivateJson } from "./paths.js";
import { foldedKeysLine, groupPlanItems } from "./plan.js";
import { countUp } from "./progress.js";
import { bold, dim, err, heading, info, note, SYM, shortId, wrapIndent } from "./theme.js";
import { capitalize, formatNumber, pluralize, stripControlDeep } from "./utils.js";

export interface Offer {
  emailsLast30Days: number | null;
  perDay: number | null;
  domains: number;
  plan: string;
  fits: string | null;
  url: string;
  text: string[];
}

export interface Report {
  version: 1;
  finishedAt: string;
  source: ProviderId;
  sourceLabel: string;
  target: { baseUrl: string; cloud: boolean; plan: string | null };
  counts: Counts;
  /** The source was only read; nothing there was changed. */
  sourceReadOnly: true;
  /** Minted this run. Printed once and part of the --json output; stripped from the files. */
  freshWebhookSecrets: { endpoint: string; secret: string }[];
  checklist: { done: string[]; left: string[] };
  /** Our DNS records per domain that still needs them. */
  dns: { domain: string; records: DnsRecord[] }[];
  apiKeys: string[];
  /** Source id → target id for topics and segments, the resources code refers to by id. */
  ids: IdMapping[];
  manual: Plan["manual"];
  failures: MigrateState["failures"];
  offer: Offer | null;
  trademark: string;
}

/** Mirror of packages/core/src/plans.ts PLAN_DAILY_LIMIT / PLAN_DOMAIN_LIMIT; null = unlimited. */
const PLANS: { id: string; perDay: number | null; domains: number | null }[] = [
  { id: "free", perDay: 100, domains: 3 },
  { id: "pro", perDay: 3000, domains: 20 },
  { id: "scale", perDay: null, domains: 100 },
];

const perDayText = (n: number | null): string =>
  n === null ? "unlimited" : `${formatNumber(n)}/day`;

function buildOffer(
  usage: TargetUsage,
  snapshot: Snapshot,
  domains: number,
  sourceLabel: string,
): Offer | null {
  if (!usage.cloud || usage.plan === null) return null;
  const sent = snapshot.metrics.emailsLast30Days;
  const perDay = sent === null ? null : Math.ceil(sent / 30);
  const current = PLANS.find((p) => p.id === usage.plan) ?? {
    id: usage.plan,
    perDay: usage.limits.emailsPerDay,
    domains: usage.limits.domains,
  };
  const label = capitalize(current.id);
  const url =
    usage.appUrl === null
      ? CLOUD_BILLING_URL
      : `${usage.appUrl.replace(/\/+$/, "")}/settings/billing`;
  const short: string[] = [];
  if (perDay !== null && current.perDay !== null && perDay > current.perDay) {
    short.push(`${label} allows ${perDayText(current.perDay)}`);
  }
  if (current.domains !== null && domains > current.domains) {
    short.push(`${label} allows ${pluralize(current.domains, "domain")}, you have ${domains}`);
  }
  if (short.length === 0 && sent === null) return null;
  const text: string[] = [];
  if (sent !== null) {
    text.push(
      `On ${sourceLabel} you sent ${formatNumber(sent)} emails in the last 30 days (~${formatNumber(perDay ?? 0)}/day).`,
    );
  }
  let fits: string | null = current.id;
  if (short.length === 0) {
    text.push(`${label} allows ${perDayText(current.perDay)}; that covers it.`);
  } else {
    const fit = PLANS.find(
      (p) =>
        p.id !== current.id &&
        (p.perDay === null || (perDay ?? 0) <= p.perDay) &&
        (p.domains === null || domains <= p.domains),
    );
    fits = fit?.id ?? null;
    text.push(
      `${short.join("; ")}; ${
        fit
          ? `${capitalize(fit.id)} (${perDayText(fit.perDay)}, ${pluralize(fit.domains ?? 0, "domain")}) fits.`
          : "no plan covers that."
      } Upgrade: ${url}`,
    );
  }
  return { emailsLast30Days: sent, perDay, domains, plan: current.id, fits, url, text };
}

export function buildReport({
  plan,
  snapshot,
  outcome,
  usage,
  targetState,
  baseUrl,
  sourceLabel,
}: {
  plan: Plan;
  snapshot: Snapshot;
  outcome: ApplyOutcome;
  usage: TargetUsage;
  targetState: TargetState;
  baseUrl: string;
  sourceLabel: string;
}): Report {
  const dns = Object.entries(outcome.domainRecords).map(([domain, records]) => ({
    domain,
    records,
  }));
  for (const domain of targetState.domains) {
    if (domain.status === "verified" || domain.name in outcome.domainRecords) continue;
    if (!snapshot.domains.some((d) => d.name === domain.name)) continue;
    dns.push({ domain: domain.name, records: domain.records });
  }
  const apiKeys = plan.items.filter((i) => i.resource === "api-keys").map((i) => i.key);
  const manual = plan.manual.filter(
    (m) => !m.title.startsWith("api-keys/") && !m.detail.startsWith("add DNS records"),
  );
  const failures = outcome.state.failures;
  const done = (Object.entries(outcome.counts) as [Resource, Counts[Resource]][])
    .filter(([, c]) => c !== undefined && c.failed === 0 && c.created + c.updated + c.unchanged > 0)
    .map(([resource]) => resource);
  const left = [
    ...dns.map((d) => `add DNS records for ${d.domain}`),
    `set ${plan.source.toUpperCase()}_BASE_URL=${baseUrl} in your app`,
    ...(apiKeys.length > 0 ? [`create API keys: ${apiKeys.join(", ")}`] : []),
    ...(outcome.ids.length > 0
      ? [`replace ${sourceLabel} topic and segment ids in your code (id map below)`]
      : []),
    ...(manual.length > 0 ? [`review ${pluralize(manual.length, "manual note")}`] : []),
    ...(failures.length > 0 ? [`retry ${pluralize(failures.length, "failed item")}`] : []),
  ];
  const domains = targetState.domains.length + (outcome.counts.domains?.created ?? 0);
  return {
    version: 1,
    finishedAt: new Date().toISOString(),
    source: plan.source,
    sourceLabel,
    target: { baseUrl, cloud: usage.cloud, plan: usage.plan },
    counts: outcome.counts,
    sourceReadOnly: true,
    freshWebhookSecrets: outcome.freshSecrets,
    checklist: { done, left },
    dns,
    apiKeys,
    ids: outcome.ids,
    manual,
    failures,
    offer: buildOffer(usage, snapshot, domains, sourceLabel),
    trademark: TRADEMARK_NOTICE,
  };
}

/** One card per record: type and name, then the whole value on its own line (a DKIM key wraps as a block, never cut). */
export function dnsCards(records: DnsRecord[]): string[] {
  return records.flatMap((r, i) => [
    ...(i > 0 ? [""] : []),
    `  ${info(r.type)}  ${r.name}${r.priority === undefined ? "" : dim(`  priority ${r.priority}`)}`,
    `    ${bold(r.value)}`,
  ]);
}

/** Two lines per pair: the name, then `shortened-source → full-target` (the target id is the thing to copy). */
export function idRows(ids: IdMapping[]): string[] {
  return ids.flatMap((m) => [
    `  ${m.resource}/${m.name}`,
    `    ${dim(shortId(m.sourceId))} → ${bold(m.targetId)}`,
  ]);
}

/** Manual notes folded like the plan: a `resource/key` title is a manual plan item again. */
function manualRows(
  manual: Plan["manual"],
): { title: string; detail: string; names?: string[] | undefined }[] {
  const items: PlanItem[] = manual.map(({ title, detail }) => {
    const slash = title.indexOf("/");
    return {
      resource: title.slice(0, slash) as Resource,
      action: "manual",
      key: title.slice(slash + 1),
      detail,
    };
  });
  return groupPlanItems(items).flatMap((g) =>
    g.rows.map((row) => ({
      title: row.keys === undefined ? `${g.resource}/${row.name}` : row.name,
      detail: row.detail ?? "",
      names: row.keys,
    })),
  );
}

/** Digit runs outside URLs in bold, so the counts stand out of a sentence. */
const boldNumbers = (text: string): string =>
  text
    .split(" ")
    .map((word) => (word.includes("://") ? word : word.replace(/\d[\d,.]*\d|\d/g, bold)))
    .join(" ");

const ITEM = { indent: "  ", hanging: "    " };

const COUNT_LABEL: Partial<Record<Resource, string>> = { enrichment: "contacts enriched" };

/** Per-resource counts in apply order. */
const orderedCounts = (counts: Counts): [Resource, ResourceCounts][] =>
  RESOURCES.flatMap((resource) => {
    const c = counts[resource];
    return c === undefined ? [] : [[resource, c] as [Resource, ResourceCounts]];
  });

export function countRows(counts: Counts): { label: string; value: number }[] {
  const rows: { label: string; value: number }[] = [];
  for (const [resource, c] of orderedCounts(counts)) {
    const name = COUNT_LABEL[resource];
    if (name !== undefined) {
      if (c.updated > 0) rows.push({ label: name, value: c.updated });
    } else {
      if (c.created > 0) rows.push({ label: `${resource} created`, value: c.created });
      if (c.updated > 0) rows.push({ label: `${resource} updated`, value: c.updated });
      if (c.unchanged > 0) rows.push({ label: `${resource} unchanged`, value: c.unchanged });
    }
    if (c.failed > 0) rows.push({ label: `${resource} failed`, value: c.failed });
  }
  return rows;
}

export const SYNC_HINT = (source: ProviderId): string =>
  `Run \`millionsend migrate --from ${source}\` again right before cutover to sync new contacts.`;

/** The numbers, the read-only assurance, secrets once, the checklist, the sync hint, then the plan offer. */
export async function printSummary(out: OutStream, raw: Report): Promise<void> {
  const report = stripControlDeep(raw);
  const line = (text: string, opts: { indent: string; hanging?: string } = ITEM): void => {
    out.write(`${wrapIndent(text, opts)}\n`);
  };
  out.write(`\n${heading("Done")}\n\n`);
  await countUp(countRows(report.counts), { stream: out });
  out.write(`\n${dim(`${report.sourceLabel} was only read; nothing there was changed.`)}\n`);
  if (report.freshWebhookSecrets.length > 0) {
    out.write("\nWebhook signing secrets, shown once (they are not saved anywhere):\n");
    for (const { endpoint, secret } of report.freshWebhookSecrets) {
      out.write(`  ${endpoint}  ${bold(secret)}\n`);
    }
  }
  const { done, left } = report.checklist;
  out.write(`\n${bold(String(done.length))} of ${done.length + left.length} steps done — left:\n`);
  for (const item of left)
    line(`${dim("[")} ${dim("]")} ${item}`, { indent: "  ", hanging: "      " });
  for (const { domain, records } of report.dns) {
    out.write(`\nDNS records for ${domain}:\n`);
    for (const card of dnsCards(records)) out.write(`${card}\n`);
  }
  if (report.ids.length > 0) {
    out.write(`\nId map (${report.sourceLabel} → MillionSend; full pairs in migrate-report.md):\n`);
    for (const row of idRows(report.ids)) out.write(`${row}\n`);
  }
  if (report.manual.length > 0) {
    out.write("\nManual notes:\n");
    for (const { title, detail, names } of manualRows(report.manual)) {
      line(`${note(SYM.manual)} ${title} — ${detail}`);
      if (names !== undefined) line(dim(foldedKeysLine(names)), { indent: "    " });
    }
  }
  if (report.failures.length > 0) {
    out.write("\nFailed:\n");
    for (const f of report.failures) line(`${err(SYM.err)} ${f.resource}/${f.key} — ${f.message}`);
  }
  out.write(`\n${dim(wrapIndent(SYNC_HINT(report.source)))}\n`);
  if (report.offer !== null)
    out.write(`\n${wrapIndent(boldNumbers(report.offer.text.join(" ")))}\n`);
}

export function renderReportMd(raw: Report): string {
  const report = stripControlDeep(raw);
  const lines = [
    `# Migration report — ${report.sourceLabel} → MillionSend`,
    "",
    `Finished ${report.finishedAt} · target ${report.target.baseUrl}${report.target.plan === null ? "" : ` · plan ${capitalize(report.target.plan)}`}`,
    "",
    "## Numbers",
    "",
    "| Resource | Created | Updated | Unchanged | Skipped | Manual | Failed |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...orderedCounts(report.counts).map(
      ([resource, c]) =>
        `| ${resource} | ${c.created} | ${c.updated} | ${c.unchanged} | ${c.skipped} | ${c.manual} | ${c.failed} |`,
    ),
    "",
    `${report.sourceLabel} was only read; nothing there was changed.`,
    "",
    "## Checklist",
    "",
    ...report.checklist.done.map((step) => `- [x] ${step}`),
    ...report.checklist.left.map((step) => `- [ ] ${step}`),
  ];
  for (const { domain, records } of report.dns) {
    lines.push(
      "",
      `### DNS records for ${domain}`,
      "",
      "| Type | Name | Priority | Value |",
      "| --- | --- | --- | --- |",
      ...records.map((r) => `| ${r.type} | ${r.name} | ${r.priority ?? ""} | \`${r.value}\` |`),
    );
  }
  if (report.apiKeys.length > 0) {
    lines.push("", "## API keys to create", "", ...report.apiKeys.map((name) => `- ${name}`));
  }
  if (report.ids.length > 0) {
    lines.push(
      "",
      "## Id map",
      "",
      `| Resource | Name | ${report.sourceLabel} id | MillionSend id |`,
      "| --- | --- | --- | --- |",
      ...report.ids.map(
        (m) => `| ${m.resource} | ${m.name} | \`${m.sourceId}\` | \`${m.targetId}\` |`,
      ),
    );
  }
  if (report.manual.length > 0) {
    lines.push(
      "",
      "## Manual notes",
      "",
      ...report.manual.map(({ title, detail }) => `- ${title} — ${detail}`),
    );
  }
  if (report.failures.length > 0) {
    lines.push(
      "",
      "## Failed",
      "",
      ...report.failures.map((f) => `- ${f.resource}/${f.key} — ${f.message}`),
    );
  }
  lines.push("", SYNC_HINT(report.source));
  if (report.offer !== null) lines.push("", ...report.offer.text);
  lines.push("", "---", "", report.trademark, "");
  return lines.join("\n");
}

/** Both files at 0600, secrets stripped; the optional extra path gets the Markdown too. */
export function writeReport(paths: MigratePaths, report: Report, extraMd: string | null): void {
  const stored: Report = { ...report, freshWebhookSecrets: [] };
  writePrivateJson(paths.reportJson, stored);
  const md = renderReportMd(stored);
  writePrivate(paths.reportMd, md);
  if (extraMd !== null) writePrivate(extraMd, md);
}
