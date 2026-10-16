import { SQSClient } from "@aws-sdk/client-sqs";
import {
  cardFingerprints,
  createStripe,
  purgeStripeEvents,
  reconcileTeamPlan,
  reportOverage,
} from "@millionsend/billing";
import {
  ABUSE_JUDGE_TIMEOUT_MS_DEFAULT,
  abuseJudgeConfig,
  abuseVisionConfig,
  disposableEmailsBlocked,
  env,
  ipGeolocationEnabled,
  receivingEnabled,
  servedRegions,
  sesTenantsEnabled,
  sharedInboxDomain,
  trackingCnameTarget,
  trackingSubdomainsSupported,
  unsubscribeBaseUrl,
} from "@millionsend/config";
import {
  anyYoungLinkDomain,
  committedDailyVolume,
  createDomainAgeResolver,
  createSharedNameReview,
  DomainAgeRetryableError,
  deriveInboxKeys,
  deriveSamplingKey,
  deriveTrackingKey,
  deriveUnsubscribeKey,
  domainsAwaitingAge,
  eraseRecipient,
  expireDrafts,
  expireInboxes,
  getInstanceSettings,
  hashRecipient,
  type InboxDeps,
  type InboxSendDeps,
  type MonitorDeps,
  markDomainAgeUnknown,
  monitorSettingsReader,
  ownerDomain,
  pacingHorizonDays,
  pausedRegions,
  postJson,
  pruneMonitorSamples,
  pruneProbes,
  purgeAccountSignups,
  purgeCampaignFingerprints,
  purgeExpiredIdempotencyKeys,
  purgeTrashedThreads,
  type QueuedWebhookDelivery,
  reconcilePendingScreens,
  recordDomainAge,
  recordMissingFingerprints,
  recordProbes,
  recountStaleSegments,
  refreshDisposableDomains,
  refreshIpGeoDatabases,
  regionBulkCounts,
  sesEventsHealth,
} from "@millionsend/core";
import { captureError, initErrorTracking } from "@millionsend/core/error-tracking-node";
import { getDb, schema } from "@millionsend/db";
import {
  EMAIL_SEND_PRIORITY,
  type EmailSendPriority,
  type EnqueueEmailSends,
  JUDGE_PRIORITY,
  Queue,
} from "@millionsend/queue";
import {
  createKeyringFromEnv,
  createSesAccountClient,
  createSesReputationClient,
  createSesv2Client,
  getAccountOverview,
  getSesComplaintRate,
  nodeDnsResolver,
  type SesIdentityClient,
} from "@millionsend/ses";
import { and, eq } from "drizzle-orm";
import { createAbuseJudge } from "./abuse-judge/index.js";
import { judgeSample } from "./handlers/abuse-judge.js";
import {
  drainQuotaParked,
  purgeExpiredApiRequests,
  purgeExpiredEmailBodies,
  purgeExpiredEmailMetadata,
  purgeExpiredReceivedContent,
  purgeExpiredReceivedMetadata,
  purgeExpiredSessions,
  purgeInboxData,
  purgeStaleHourlyUsage,
  reapStaleTrackingSubdomains,
  reapUnverifiedDomains,
  reconcileBillingPlans,
  reconcileStalledBroadcasts,
  reconcileStalledSends,
  reconcileWebhookDeliveries,
  reverifyDomains,
  stripExpiredEventPayloads,
} from "./handlers/cron.js";
import { drainWebhookEndpoint } from "./handlers/deliver-webhook.js";
import { forwardToOwners } from "./handlers/inbox-forward.js";
import { runInstanceProbes } from "./handlers/instance-probes.js";
import { alertLinkedTeams } from "./handlers/linkage-alerts.js";
import { runMonitorHealth } from "./handlers/monitor-health.js";
import { reportPlanMove, sweepNotifications } from "./handlers/notify.js";
import { runPlatformBreaker } from "./handlers/platform-breaker.js";
import { processSesEvent } from "./handlers/process-ses-event.js";
import { runRevealNotices } from "./handlers/reveal-notices.js";
import { runSafetyFlags } from "./handlers/safety-flags.js";
import { screenReceived } from "./handlers/screen-received.js";
import { finalizeBroadcast, sendBroadcast } from "./handlers/send-broadcast.js";
import { failQueuedEmail, sendEmail } from "./handlers/send-email.js";
import { createRegionSendControls } from "./handlers/ses-regions.js";
import {
  queueMissingSharedSubdomains,
  runSharedSubdomainJob,
} from "./handlers/shared-subdomain.js";
import {
  abandonTenantStatus,
  retryTenantStatus,
  sharedTenantResolver,
  syncTenants,
} from "./handlers/tenants.js";
import { mediaPool } from "./media/scan.js";
import { createAbuseVision } from "./media/vision.js";
import { createSesSender } from "./ses-sender.js";
import { startSqsPoller } from "./sqs-poller.js";
import { createSystemMailer } from "./system-mail.js";

await initErrorTracking("worker");

if (!env.MASTER_ENCRYPTION_KEY) {
  // Required even when cloud wraps DEKs with KMS: tracking/unsubscribe token
  // keys derive from this key via HKDF, and KMS cannot serve as a local
  // derivation root.
  throw new Error("MASTER_ENCRYPTION_KEY is required to start the worker");
}

const db = getDb();
const keyring = createKeyringFromEnv(env);
// Days whole email rows (recipients, subject, events) are kept; bodies age
// out earlier on EMAIL_RETENTION_DAYS. Read here until it joins the env schema.
const metadataRetentionDays = env.EMAIL_METADATA_RETENTION_DAYS;
const stripe = env.IS_CLOUD && env.STRIPE_SECRET_KEY ? createStripe(env.STRIPE_SECRET_KEY) : null;
const masterKeyBytes = Buffer.from(env.MASTER_ENCRYPTION_KEY, "base64");
const unsubscribeSecretKey = deriveUnsubscribeKey(masterKeyBytes);
// App-layer tracking signs tokens with an HKDF-derived key; defaultBaseUrl is
// the redirect host for domains without a custom tracking subdomain. Absent
// APP_BASE_URL only fails a send whose domain has tracking on and no subdomain.
const tracking = {
  secretKey: deriveTrackingKey(masterKeyBytes),
  allowSubdomains: trackingSubdomainsSupported(),
  requireBrandedHost: env.IS_CLOUD,
  ...(env.APP_BASE_URL ? { defaultBaseUrl: env.APP_BASE_URL } : {}),
};
// Absent APP_BASE_URL doesn't stop the worker — transactional mail still
// flows — but broadcast fan-out and broadcast sends refuse loudly.
const unsubscribeHost = unsubscribeBaseUrl();
const unsubscribe = unsubscribeHost
  ? { secretKey: unsubscribeSecretKey, baseUrl: unsubscribeHost }
  : undefined;
// The links this instance writes into customer mail (unsubscribe, the
// dashboard) lead nowhere new: screening never counts them as destinations.
const platformDomains = new Set(
  [unsubscribeHost, env.APP_BASE_URL].flatMap((url) =>
    url && URL.canParse(url) ? [ownerDomain(new URL(url).hostname)] : [],
  ),
);
// Mail with no domain row (platform mail, the shared inbox domain's) goes out
// in the default region, the first served, so the shared identity's tenant
// associations are made there too.
const regions = servedRegions();
const defaultRegion = regions[0] ?? env.AWS_REGION;
const ses = createSesSender(defaultRegion);
// SESv2 identity clients (GetEmailIdentity) for domain re-verification, cached
// per region since identities live in the domain's region. Distinct from the
// send client above (SendEmail); credentials fall back to the provider chain.
const identityClients = new Map<string, SesIdentityClient>();
const clientForRegion = (region: string): SesIdentityClient => {
  let client = identityClients.get(region);
  if (!client) {
    client = createSesv2Client({
      region,
      ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
        ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
        : {}),
    });
    identityClients.set(region, client);
  }
  return client;
};
const sharedDomain = sharedInboxDomain();
const sharedTenant =
  sesTenantsEnabled() && sharedDomain
    ? sharedTenantResolver(db, {
        client: clientForRegion(defaultRegion),
        region: defaultRegion,
        sharedInboxDomain: sharedDomain,
      })
    : undefined;
// One GetAccount client per served region: the 24-hour quota and the send
// rate are both per region.
const accountClients = new Map<string, ReturnType<typeof createSesAccountClient>>();
const accountClientFor = (region: string) => {
  let client = accountClients.get(region);
  if (!client) {
    client = createSesAccountClient({
      region,
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    });
    accountClients.set(region, client);
  }
  return client;
};
// SES publishes each region's reputation (its own complaint rate) to
// CloudWatch in that region.
const sesUnreadableLoggedAt = new Map<string, Date>();
const reputationClients = new Map(
  regions.map((region) => [
    region,
    createSesReputationClient({
      region,
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    }),
  ]),
);
// The buckets are the messages/second control; worker concurrency is not a
// rate limit and must never be treated as one. In-memory ⇒ single worker
// process only (see SES_MAX_SEND_RATE in @millionsend/config); each process
// takes its share of the rate, so WORKER_REPLICAS keeps N processes at the
// account's total. A region's rate is its own MaxSendRate under the ceiling
// the db-backed instance setting (else env) sets — a sandbox region paces
// itself at 1/s without holding the others back. Polled once a minute
// together with the rolling 24-hour quota, so sends park as queued_quota
// before SES starts refusing them and a Settings → Instance change applies
// without a restart. A failed read keeps the region's last answers.
// The broadcast share and its room ledger are in-process too: with more
// than one replica each over-admits by at most one room, which the gate
// parks, and the parked-transactional probe reads one replica's memory.
const sendControls = createRegionSendControls({
  regions,
  read: async (region) => (await getAccountOverview(accountClientFor(region))).quota,
  ceiling: async () => (await getInstanceSettings(db)).sesMaxSendRate ?? env.SES_MAX_SEND_RATE,
  reserve: async () =>
    (await getInstanceSettings(db)).sesTransactionalReserve ?? env.SES_TRANSACTIONAL_RESERVE,
  counts: () => regionBulkCounts(db),
  paused: async () => new Set((await pausedRegions(db)).map((p) => p.region)),
  initialRate: env.SES_MAX_SEND_RATE,
  replicas: env.WORKER_REPLICAS,
});
await sendControls.refreshAll();
setInterval(() => void sendControls.refreshAll(), 60_000).unref();
// The owner's estimate stops where the send would be refused: the horizon
// the web and the API derive from the same retention setting.
const horizonDays = async () =>
  pacingHorizonDays((await getInstanceSettings(db)).emailRetentionDays ?? env.EMAIL_RETENTION_DAYS);

const queue = await Queue.start(env.DATABASE_URL, {
  workers: true,
  onJobError: (error, job) => void captureError(error, { tags: { job } }),
});

// Everything the worker itself enqueues is bulk unless the caller says
// otherwise: broadcast fan-out always, drained or reconciled rows by origin.
// A page of sends is one statement; a single send is a page of one.
const enqueueSends: EnqueueEmailSends = async (batch) => {
  await queue.sendMany(
    "email.send",
    batch.map(({ emailId, startAfter, priority }) => ({
      payload: { emailId },
      dedupeKey: emailId,
      priority: priority ?? EMAIL_SEND_PRIORITY.bulk,
      startAfter,
    })),
  );
};
const enqueueSend = (emailId: string, startAfter?: Date, priority?: EmailSendPriority) =>
  enqueueSends([{ emailId, startAfter, priority }]);

// Account mail rides the pipeline, so the mailer needs the queue it enqueues into.
const mailer = createSystemMailer({ db, keyring, enqueueSend });

// The content monitor: off unless ABUSE_JUDGE names a provider. When on, a
// new team's mail is judged before SES and an accepted send may be drawn and
// judged after the fact; the sampling key is derived like the token keys,
// the settings row is re-read once a minute.
const judgeConfig = abuseJudgeConfig();
const judge = createAbuseJudge(judgeConfig);
// The image reader the judge's media read hands images to; null while ABUSE_VISION is off.
const vision = createAbuseVision(abuseVisionConfig());
// The parsing threads boot now, WASM compiled, so the first email with a file never waits on them.
mediaPool().warm();
const monitorSettings = monitorSettingsReader(db, env as unknown as Record<string, unknown>);
const monitor: MonitorDeps | undefined = judge
  ? {
      samplingKey: deriveSamplingKey(masterKeyBytes),
      settings: monitorSettings,
      enqueueJudge: async (sampleId, opts) => {
        await queue.send(
          "abuse.judge",
          { sampleId },
          {
            dedupeKey: sampleId,
            group: opts?.teamId,
            priority: opts?.screening ? JUDGE_PRIORITY.screening : JUDGE_PRIORITY.sample,
            startAfter: opts?.startAfter,
          },
        );
      },
    }
  : undefined;
const monitorHealthState = { degradedMailedAt: null as Date | null };
if (judge) console.log(`content monitor: ${judge.provider} · ${judge.model}`);

/**
 * Concurrent send lanes. One send waits on KMS, SES and a few writes (about a
 * second), so a single lane moves about one email a second while the rate
 * bucket sits full. Sixteen lanes saturate a 14/s bucket with room to spare;
 * the bucket, not this number, is what SES sees. The db pool (packages/db) is
 * sized for them. Each lane fetches two jobs at a time so a backlog is pulled
 * continuously instead of one job per polling interval.
 */
const SEND_CONCURRENCY = env.SEND_CONCURRENCY;
const SEND_BATCH = 2;

/**
 * SES event lanes. A burst of sends comes back as the same burst of delivery
 * events within a minute; each is a short transaction, so four lanes pulling
 * ten at a time keep the Sent → Delivered flip close to real time.
 */
const EVENT_CONCURRENCY = 4;
const EVENT_BATCH = 10;

// Whatever rows a fan-out wrote, one drain job per distinct endpoint:
// webhook_deliveries is the backlog, the job only names the endpoint to walk.
const enqueueWebhook = async (deliveries: readonly QueuedWebhookDelivery[]): Promise<void> => {
  await queue.drainWebhookEndpoints(deliveries.map((d) => d.endpointId));
};

const inboxDeps: InboxDeps = {
  sharedInboxDomain: sharedInboxDomain() ?? null,
  receivingEnabled: receivingEnabled(),
  enqueueWebhookDeliveries: enqueueWebhook,
};
// forward_to passes go through the accept pipeline like an API send, so they
// enqueue as transactional mail.
const inboxSendDeps: InboxSendDeps = {
  db,
  keyring,
  isCloud: env.IS_CLOUD,
  enqueueEmailSend: (emailId, opts) =>
    enqueueSend(emailId, opts?.startAfter, EMAIL_SEND_PRIORITY.transactional),
  inboxKeys: deriveInboxKeys(masterKeyBytes),
  sharedInboxDomain: inboxDeps.sharedInboxDomain,
  monitorSettings,
  enqueueWebhookDeliveries: enqueueWebhook,
};

const enqueueDomainAge = async (domainId: string): Promise<void> => {
  await queue.send("domain.age", { domainId }, { dedupeKey: domainId });
};
// The warm-up caps by a sending domain's age and the review hold reads it,
// so registries are asked while either can act.
const domainAgeWanted = async (): Promise<boolean> => {
  const s = await monitorSettings();
  return s.warmupEnabled || (judge !== null && s.autoHold);
};
// One resolver for the process: it holds the RDAP bootstrap, the WHOIS
// referrals, the hosts in Retry-After backoff and the crt.sh clock.
const domainAge = createDomainAgeResolver();
// How long a verdict waits on a new link domain's age; a lookup still
// running then fills the shared cache for the next one.
const LINK_AGE_BUDGET_MS = 10_000;

const enqueueBroadcast = async (broadcastId: string, startAfter?: Date): Promise<void> => {
  await queue.send(
    "broadcast.send",
    { broadcastId },
    { dedupeKey: broadcastId, ...(startAfter ? { startAfter } : {}) },
  );
};

const backfillSharedSubdomains = async (): Promise<void> => {
  const { stamped, queued } = await queueMissingSharedSubdomains(db, {
    sharedInboxDomain: sharedDomain,
    sendMany: (jobs) => queue.enqueueSharedSubdomains(jobs),
  });
  if (stamped > 0 || queued > 0) {
    console.log(`shared.subdomain: stamped=${stamped} queued=${queued}`);
  }
};

// Crons and dead-letter workers first: they poll slowly and must never wait
// behind the send lanes' registration on a backlog.
await queue.scheduleCrons({
  "quota.drain": async () => {
    const result = await drainQuotaParked(db, {
      isCloud: env.IS_CLOUD,
      enqueueSends,
      sesQuota: sendControls,
      finalize: (id) => finalizeBroadcast(db, { mailer, appBaseUrl: env.APP_BASE_URL }, id),
    });
    console.log(`quota.drain: drained=${result.drained} stillParked=${result.stillParked}`);
  },
  "sends.reconcile": async () => {
    const requeued = await reconcileStalledSends(db, {
      enqueueSends,
      enqueueWebhookDelivery: enqueueWebhook,
    });
    if (requeued > 0) console.log(`sends.reconcile: requeued=${requeued}`);
    const screens = await reconcilePendingScreens(db, (p) => queue.enqueueScreening(p));
    if (screens > 0) console.log(`sends.reconcile: screens=${screens}`);
  },
  "retention.purge": async () => {
    const purged = await purgeExpiredEmailBodies(db, {
      defaultRetentionDays: env.EMAIL_RETENTION_DAYS,
    });
    const requests = await purgeExpiredApiRequests(db, {
      defaultRetentionDays: env.EMAIL_RETENTION_DAYS,
    });
    const stripped = await stripExpiredEventPayloads(db, {
      defaultRetentionDays: env.EMAIL_RETENTION_DAYS,
    });
    const metadata = await purgeExpiredEmailMetadata(db, {
      retentionDays: metadataRetentionDays,
      deliveryRetentionDays: env.WEBHOOK_DELIVERY_RETENTION_DAYS,
    });
    const receivedPurged = await purgeExpiredReceivedContent(db, {
      defaultRetentionDays: env.EMAIL_RETENTION_DAYS,
    });
    const receivedDeleted = await purgeExpiredReceivedMetadata(db, {
      retentionDays: metadataRetentionDays,
    });
    // After the received metadata purge, whose deletes cascade to memberships.
    const now = new Date();
    const inboxData = await purgeInboxData(db, {
      contentDays: (await getInstanceSettings(db)).emailRetentionDays ?? env.EMAIL_RETENTION_DAYS,
      metadataDays: metadataRetentionDays,
      now,
    });
    const inboxesExpired = await expireInboxes(db, inboxDeps, now);
    const trashedThreads = await purgeTrashedThreads(db, now);
    const draftsExpired = await expireDrafts(db, inboxSendDeps, now);
    const sessions = await purgeExpiredSessions(db);
    const hourlyUsage = await purgeStaleHourlyUsage(db);
    const stripeEvents = await purgeStripeEvents(db);
    const probes = await pruneProbes(db);
    const monitorSamples = await pruneMonitorSamples(db);
    const signups = await purgeAccountSignups(db);
    const fingerprints = await purgeCampaignFingerprints(db);
    // The console's retention row: how many bodies the last run purged.
    await recordProbes(db, [{ probe: "retention_purged", value: purged, ok: true }]);
    const counts = {
      purged,
      probes,
      monitorSamples,
      hourlyUsage,
      apiRequests: requests,
      events: stripped.events,
      deliveries: stripped.deliveries,
      emails: metadata.emails,
      oldDeliveries: metadata.deliveries,
      broadcastsFrozen: metadata.broadcasts,
      receivedPurged,
      receivedDeleted,
      ...inboxData,
      inboxesExpired,
      trashedThreads,
      draftsExpired,
      sessions,
      signups,
      fingerprints,
      stripeEvents,
    };
    if (Object.values(counts).some((n) => n > 0)) {
      console.log(
        `retention.purge: ${Object.entries(counts)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}`,
      );
    }
  },
  "billing.reconcile": async () => {
    if (!stripe) return;
    const result = await reconcileBillingPlans(db, {
      reconcileTeam: (teamId) => reconcileTeamPlan({ db, stripe, log: console.warn }, teamId),
      onPlanMoved: async (team, before, after) => {
        await reportPlanMove(db, mailer, env.APP_BASE_URL ?? "", team, before, after);
      },
    });
    // Sold capacity against the shared SES quotas, once a day where the operator reads logs.
    const committed = await committedDailyVolume(db);
    const sesDaily = await Promise.all(
      regions.map((region) =>
        getAccountOverview(accountClientFor(region)).then(
          (o) => `${region}:${o.quota.max24h}`,
          () => `${region}:unknown`,
        ),
      ),
    );
    console.log(
      `billing.reconcile: reconciled=${result.reconciled} failed=${result.failed} committedPerDay=${committed} sesDailyQuota=${sesDaily.join(",")}`,
    );
  },
  "billing.overage": async () => {
    if (!stripe) return;
    const result = await reportOverage({ db, stripe, log: console.warn });
    if (result.reported > 0 || result.failed > 0) {
      console.log(`billing.overage: reported=${result.reported} failed=${result.failed}`);
    }
  },
  "idempotency.purge": async () => {
    await purgeExpiredIdempotencyKeys(db);
  },
  "webhooks.reconcile": async () => {
    const armed = await reconcileWebhookDeliveries(db, { enqueue: enqueueWebhook });
    if (armed > 0) console.log(`webhooks.reconcile: armed=${armed}`);
  },
  "broadcasts.reconcile": async () => {
    const requeued = await reconcileStalledBroadcasts(db, {
      enqueue: (broadcastId) => enqueueBroadcast(broadcastId),
      finalize: (id) => finalizeBroadcast(db, { mailer, appBaseUrl: env.APP_BASE_URL }, id),
    });
    if (requeued > 0) console.log(`broadcasts.reconcile: requeued=${requeued}`);
  },
  "segments.recount": async () => {
    const recounted = await recountStaleSegments(db, { olderThanMs: 30 * 60_000 });
    if (recounted > 0) console.log(`segments.recount: recounted=${recounted}`);
  },
  "notifications.sweep": async () => {
    const result = await sweepNotifications(db, {
      isCloud: env.IS_CLOUD,
      mailer,
      enqueueWebhook,
      appBaseUrl: env.APP_BASE_URL,
    });
    if (result.sent > 0) console.log(`notifications.sweep: sent=${result.sent}`);
    const linked = await alertLinkedTeams(db, { mailer, appBaseUrl: env.APP_BASE_URL });
    if (linked > 0) console.log(`notifications.sweep: linkedTeamAlerts=${linked}`);
  },
  "platform.breaker": async () => {
    // Runs without SES events too: SES's own complaint rate needs none.
    await runPlatformBreaker(db, {
      mailer,
      appBaseUrl: env.APP_BASE_URL,
      ses: {
        regions,
        complaintRate: async (region) => {
          const client = reputationClients.get(region);
          return client ? getSesComplaintRate(client) : null;
        },
        loggedAt: sesUnreadableLoggedAt,
      },
    });
  },
  "instance.probe": async () => {
    await runInstanceProbes(db, {
      isCloud: env.IS_CLOUD,
      keyring,
      eventsConfigured: Boolean(env.SNS_TOPIC_ARNS?.length),
      regions,
      txParkedAt: (region) => sendControls.txParkedAt(region),
    });
  },
  "safety.flags": async () => {
    // With the judge off a stored risk opens nothing: the line is unreachable.
    const result = await runSafetyFlags(db, {
      monitorFlagRisk: judge ? (await monitorSettings()).flagRisk : Number.POSITIVE_INFINITY,
    });
    if (result.opened > 0 || result.cleared > 0 || result.graduated > 0) {
      console.log(
        `safety.flags: teams=${result.teams} opened=${result.opened} cleared=${result.cleared} warmupGraduated=${result.graduated}`,
      );
    }
    // Phishing teams suspended before linkage existed, or whose capture failed.
    await recordMissingFingerprints(db, {
      keyring: () => keyring,
      cards: stripe ? (customerId) => cardFingerprints(stripe, customerId) : undefined,
    });
  },
  "safety.reveal_notices": async () => {
    const result = await runRevealNotices(db);
    if (result.disclosed > 0 || result.withheld > 0) {
      console.log(
        `safety.reveal_notices: disclosed=${result.disclosed} withheld=${result.withheld}`,
      );
    }
  },
  "monitor.health": async () => {
    const result = await runMonitorHealth(db, {
      judge: judgeConfig,
      mailer,
      appBaseUrl: env.APP_BASE_URL,
      state: monitorHealthState,
      enqueueJudge: monitor?.enqueueJudge,
    });
    if (result.lost > 0 || result.degraded) {
      console.warn(
        `monitor.health: samples1h=${result.samples} unjudged=${result.unjudged} lost=${result.lost} degraded=${result.degraded}`,
      );
    }
  },
  "events.health": async () => {
    // No topic allowlist = ingestion disabled on purpose; nothing to judge.
    if (!env.SNS_TOPIC_ARNS?.length) return;
    const health = await sesEventsHealth(db);
    if (health.status !== "unhealthy") return;
    console.warn(
      `events.health: ${health.sentInWindow} email(s) sent in the last 2h but no SES event arrived (last one ${health.lastSesEventAt?.toISOString() ?? "never"}) — the SNS subscription is missing or pending confirmation, or SQS_QUEUE_URL is empty / the queue is not being read`,
    );
  },
  "domains.reverify": async () => {
    // First and on its own: a throw here skips no domain check, and none of theirs skips this.
    try {
      await backfillSharedSubdomains();
    } catch (err) {
      console.warn("shared.subdomain: sweep failed; the next run tries again", err);
    }
    const result = await reverifyDomains(db, {
      clientForRegion,
      resolver: nodeDnsResolver,
      enqueueDomainAge,
    });
    if (result.checked > 0 || result.failed > 0) {
      console.log(`domains.reverify: checked=${result.checked} failed=${result.failed}`);
    }
    // Domains no age lookup has answered for: rows from before the job, a
    // lost enqueue, or added while neither the warm-up nor the hold was on.
    if (await domainAgeWanted()) {
      const awaiting = await domainsAwaitingAge(db);
      for (const domainId of awaiting) await enqueueDomainAge(domainId);
      if (awaiting.length > 0) console.log(`domains.age: queued=${awaiting.length}`);
    }
    // Branded tracking CNAMEs never gate domain status, so reverify above skips
    // them; sweep them here to clear a resolved subdomain's clock or unset one
    // that never resolved. trackingCnameTarget short-circuits to the edge host
    // before parsing APP_BASE_URL, so an empty fallback is only ever ignored.
    const trackingCnameValue =
      env.TRACKING_EDGE_HOST || env.APP_BASE_URL
        ? trackingCnameTarget(env.APP_BASE_URL ?? "")
        : null;
    const tracking = await reapStaleTrackingSubdomains(db, {
      resolver: nodeDnsResolver,
      trackingCnameValue,
    });
    if (tracking.unset > 0) console.log(`domains.reap-tracking: unset=${tracking.unset}`);
  },
  "tenants.sync": async () => {
    const result = await syncTenants(db, {
      clientForRegion,
      configurationSet: env.SES_CONFIGURATION_SET,
      enabled: sesTenantsEnabled(),
    });
    if (result.associated > 0 || result.failed > 0) {
      console.log(`tenants.sync: associated=${result.associated} failed=${result.failed}`);
    }
  },
  "reference.refresh": async () => {
    if (disposableEmailsBlocked()) {
      console.log(`reference.refresh: disposable_domains=${await refreshDisposableDomains(db)}`);
    }
    if (ipGeolocationEnabled()) {
      const held = await refreshIpGeoDatabases(db);
      console.log(
        `reference.refresh: ${Object.entries(held)
          .map(([name, month]) => `${name}=${month ?? "none"}`)
          .join(" ")}`,
      );
    }
  },
  "domains.reap": async () => {
    // Cloud-only: squatting is a cross-tenant problem. Self-host is one
    // operator's own teams and adopts existing SES identities on create, so
    // an unverified row blocks nobody there.
    if (!env.IS_CLOUD) return;
    const reaped = await reapUnverifiedDomains(db, {
      clientForRegion,
      enqueueWebhookDelivery: enqueueWebhook,
    });
    if (reaped > 0) console.log(`domains.reap: reaped=${reaped}`);
  },
});

// A deploy can restart the process while a Stripe event is mid-flight; Stripe
// retries it, but the daily reconcile is hours away. One pass at boot closes
// the gap at once.
if (stripe) {
  queue.runCronNow("billing.reconcile").catch((err) => {
    console.warn("billing.reconcile at boot failed; the daily run covers it", err);
  });
}

// A fresh instance would otherwise wait for the daily run to have any copy.
queue.runCronNow("reference.refresh").catch((err) => {
  console.warn("reference.refresh at boot failed; the daily run covers it", err);
});

// Teams still without a label, such as every team when the shared domain is
// first set, are queued now rather than at the first sweep.
backfillSharedSubdomains().catch((err) => {
  console.warn("shared.subdomain at boot failed; the 15-minute sweep covers it", err);
});

// Retries exhausted: the row must not stay "queued" for the reconcile sweep
// to resurrect forever.
await queue.workDeadLetter("email.send", async ({ emailId }) => {
  const failed = await failQueuedEmail(db, emailId, "retries_exhausted", enqueueWebhook);
  console.error(`email.send: dead-lettered ${emailId} (marked failed=${failed})`);
});

// An erasure that exhausted its retries must not vanish: the log names the
// team and the address's hash (never the address, which is what is being
// erased) so an operator can re-run it from Audience → Erase recipient.
await queue.workDeadLetter("recipient.erase", async ({ teamId, address }) => {
  console.error(
    `recipient.erase: dead-lettered team=${teamId} recipient=${hashRecipient(address)}; re-run it from Audience → Erase recipient`,
  );
});

// A drain that kept throwing: its rows stay open and the reconcile sweep
// arms a fresh pass once they read as stale.
await queue.workDeadLetter("webhook.drain", async ({ endpointId }) => {
  console.error(`webhook.drain: dead-lettered endpoint ${endpointId}`);
});

// A judge job that kept throwing (database or decrypt errors, not the judge's
// own failures, which never throw): the sample reads as unjudged, never pending.
await queue.workDeadLetter("abuse.judge", async ({ sampleId }) => {
  await db
    .update(schema.monitorSamples)
    .set({ status: "unjudged", errorClass: "lost", judgedAt: new Date() })
    .where(
      and(eq(schema.monitorSamples.id, sampleId), eq(schema.monitorSamples.status, "pending")),
    );
  console.error(`abuse.judge: dead-lettered sample ${sampleId}`);
});

await queue.workDeadLetter("tenant.status", ({ teamId }) => abandonTenantStatus(db, teamId));

// A screening that kept throwing leaves its membership pending, invisible
// to agents; sends.reconcile retries it.
await queue.workDeadLetter("received.screen", async ({ receivedEmailId, inboxId }) => {
  console.error(`received.screen: dead-lettered ${receivedEmailId} inbox=${inboxId}`);
});

await queue.workDeadLetter("inbox.forward", async ({ receivedEmailId, inboxId }) => {
  console.error(`inbox.forward: dead-lettered ${receivedEmailId} inbox=${inboxId}`);
});

// Every source kept failing: the domain reads as unknown age, which the
// warm-up treats by the team's standing, until verification asks again.
await queue.workDeadLetter("domain.age", ({ domainId }) => markDomainAgeUnknown(db, domainId));

await queue.work(
  "email.send",
  async (payload) => {
    await sendEmail(
      db,
      {
        keyring,
        ses,
        defaultConfigurationSet: env.SES_CONFIGURATION_SET,
        onboardingEmailFrom: env.ONBOARDING_EMAIL_FROM,
        settings: monitorSettings,
        sharedTenant,
        throttle: (region) => sendControls.throttle(region),
        reschedule: (emailId, at, priority) => enqueueSend(emailId, at, priority),
        sesQuota: sendControls,
        enqueueWebhookDelivery: enqueueWebhook,
        tracking,
        monitor,
        platformDomains,
        ...(unsubscribe ? { unsubscribe } : {}),
      },
      payload,
    );
  },
  { concurrency: SEND_CONCURRENCY, batchSize: SEND_BATCH },
);

await queue.work(
  "broadcast.send",
  async (payload, ctx) => {
    await sendBroadcast(
      db,
      {
        keyring,
        unsubscribeSecretKey,
        unsubscribeBaseUrl: unsubscribeHost,
        isCloud: env.IS_CLOUD,
        enqueueEmailSends: enqueueSends,
        reschedule: (broadcastId, at) => enqueueBroadcast(broadcastId, at),
        signal: ctx.signal,
        mailer,
        appBaseUrl: env.APP_BASE_URL,
        sesQuota: sendControls,
        horizonDays,
        monitor,
        platformDomains,
      },
      payload,
    );
  },
  // Two broadcasts fired together fan out side by side instead of the
  // second waiting for the first's whole walk.
  { concurrency: 2 },
);

// Judge calls: a few lanes, each pulling two jobs a fetch so a burst is
// worked continuously, and one team (the job's group) on at most two of them
// so its burst never starves another team's screening. A throttle is retried
// through the queue's backoff, not in-process.
await queue.work(
  "abuse.judge",
  async ({ sampleId }) => {
    await judgeSample(
      db,
      {
        judge,
        keyring,
        settings: monitorSettings,
        timeoutMs: judgeConfig?.timeoutMs,
        mailer,
        appBaseUrl: env.APP_BASE_URL,
        syncTenant: async (teamId) => {
          await queue.send("tenant.status", { teamId }, { dedupeKey: teamId });
        },
        enqueueSend: (emailId, priority) => enqueueSend(emailId, undefined, priority),
        enqueueBroadcast: (broadcastId) => enqueueBroadcast(broadcastId),
        platformDomains,
        linkDomainYoung: (domains, at) =>
          anyYoungLinkDomain(db, domainAge, domains, at, { budgetMs: LINK_AGE_BUDGET_MS }),
        media: { vision },
      },
      { sampleId },
    );
  },
  { concurrency: 4, batchSize: 2, groupConcurrency: 2 },
);

// The inbound judge: a few lanes, at most two on one inbox's mail at a time.
await queue.work(
  "received.screen",
  async (job) => {
    await screenReceived(
      db,
      {
        judge,
        keyring,
        settings: await monitorSettings(),
        timeoutMs: judgeConfig?.timeoutMs ?? ABUSE_JUDGE_TIMEOUT_MS_DEFAULT,
        enqueueWebhookDeliveries: enqueueWebhook,
        enqueueInboxForward: (p) => queue.enqueueInboxForward(p),
      },
      job,
    );
  },
  { concurrency: 4, groupConcurrency: 2 },
);

await queue.work(
  "inbox.forward",
  (job) => forwardToOwners(db, inboxSendDeps, job, (at) => queue.enqueueInboxForward(job, at)),
  { concurrency: 2 },
);

await queue.work(
  "ses.event",
  async (payload) => {
    await processSesEvent(db, payload.event, {
      snsMessageId: payload.snsMessageId,
      enqueueWebhookDelivery: enqueueWebhook,
    });
  },
  { concurrency: EVENT_CONCURRENCY, batchSize: EVENT_BATCH },
);

// SES events over SQS for deployments without a public https URL. The topic
// allowlist gates it exactly like the https endpoint — a queue URL without
// the allowlist stays inert instead of accepting arbitrary payloads.
if (env.SQS_QUEUE_URL) {
  const allowedTopicArns = env.SNS_TOPIC_ARNS ?? [];
  if (allowedTopicArns.length === 0) {
    console.warn("SQS_QUEUE_URL is set but SNS_TOPIC_ARNS is empty — SQS event polling disabled");
  } else {
    startSqsPoller({
      sqs: new SQSClient({
        region: env.AWS_REGION,
        ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
          ? {
              credentials: {
                accessKeyId: env.AWS_ACCESS_KEY_ID,
                secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
              },
            }
          : {}),
      }),
      queueUrl: env.SQS_QUEUE_URL,
      allowedTopicArns,
      concurrency: env.SQS_POLL_CONCURRENCY,
      enqueueSesEvent: async (event, snsMessageId) => {
        await queue.send("ses.event", { event, snsMessageId }, { dedupeKey: snsMessageId });
      },
      log: (line) => console.warn(line),
    });
    console.log(`sqs poller: long-polling ${env.SQS_QUEUE_URL}`);
  }
}

await queue.work(
  "webhook.drain",
  async ({ endpointId }, ctx) => {
    await drainWebhookEndpoint(
      db,
      {
        keyring,
        post: (url, body, headers) =>
          postJson(url, { body, headers, allowLocalhost: env.WEBHOOK_ALLOW_LOCALHOST }),
        rearm: (id, at) => queue.drainWebhookEndpoints([id], at),
        signal: ctx.signal,
      },
      { endpointId },
    );
  },
  // The group is the endpoint and one pass per group runs at a time, so a
  // successor armed mid-pass waits for the pass to end; a pass is time-boxed,
  // so a stalled receiver holds one of these lanes for at most a budget
  // before its successor queues behind everyone else's.
  { concurrency: 8, batchSize: 1, groupConcurrency: 1 },
);

await queue.work(
  "tenant.status",
  ({ teamId }) => retryTenantStatus(db, { clientForRegion, enabled: sesTenantsEnabled() }, teamId),
  { pollingIntervalSeconds: 30 },
);

// One lane: crt.sh is spaced per process, and a lookup is a few slow GETs.
// A retryable failure throws into pg-boss's backoff.
await queue.work("domain.age", async ({ domainId }) => {
  // No registry is asked while nothing reads the age; the sweep asks once something does.
  if (!(await domainAgeWanted())) return;
  try {
    const age = await recordDomainAge(db, domainAge, domainId);
    if (age) {
      console.log(
        `domain.age: ${age.domain ?? "-"} source=${age.source} registered=${age.registeredAt?.toISOString() ?? "unknown"}`,
      );
    }
  } catch (err) {
    if (err instanceof DomainAgeRetryableError)
      console.warn(`domain.age: ${err.message}; retrying`);
    throw err;
  }
});

// Two lanes keep the name review's load low; a batch above one keeps a
// backfill burst fetching.
if (sharedDomain) {
  const review = createSharedNameReview(judgeConfig);
  await queue.work(
    "shared.subdomain",
    (job) =>
      runSharedSubdomainJob(
        db,
        {
          sharedInboxDomain: sharedDomain,
          review,
          requeue: (next, startAfter) => queue.enqueueSharedSubdomains([next], startAfter),
        },
        job,
      ),
    { concurrency: 2, batchSize: 10 },
  );
}

// Erasure scans a team's whole history; it runs here so the request that
// asked for it returns at once.
await queue.work(
  "recipient.erase",
  async ({ teamId, address }) => {
    await eraseRecipient(db, teamId, address);
  },
  { pollingIntervalSeconds: 30 },
);
console.log("millionsend worker running");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    queue.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
