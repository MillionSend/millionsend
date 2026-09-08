import { PgBoss } from "pg-boss";

/**
 * Thin, typed wrapper over pg-boss — the seam behind which Redis/BullMQ can
 * arrive later without touching product code (stack decision §0). Job
 * payloads are minimal references; workers re-read authoritative state from
 * Postgres — a payload is never trusted as truth.
 */

export interface JobPayloads {
  "email.send": { emailId: string };
  "broadcast.send": { broadcastId: string };
  // snsMessageId rides along for durable idempotency in the handler; queue
  // dedupe alone cannot cover an SNS redelivery after the job completed.
  "ses.event": { event: SerializedSesEvent; snsMessageId: string };
  // One self-rescheduling drain per endpoint: webhook_deliveries is the
  // backlog, so the job table never grows with a slow receiver's queue.
  "webhook.drain": { endpointId: string };
  // Cross-table scrub of one address after its contact was deleted; too slow
  // for a request on a large team, so it runs here.
  "recipient.erase": { teamId: string; address: string };
}

/** ParsedSesEvent with occurredAt as ISO string (JSON-safe). */
export interface SerializedSesEvent {
  eventType: string;
  sesMessageId: string;
  emailId?: string;
  occurredAt: string;
  bounce?: {
    bounceType: "Permanent" | "Transient" | "Undetermined";
    bounceSubType: string;
    recipients: string[];
    diagnosticCode?: string;
  };
  complaint?: { complaintFeedbackType?: string; recipients: string[] };
  delivery?: { smtpResponse?: string; processingTimeMillis?: number };
  click?: { link?: string };
  data: Record<string, unknown>;
}

export type JobName = keyof JobPayloads;

/**
 * Fetch order inside the email.send queue: pg-boss serves the higher priority
 * first, then the older job. A transactional email (API, SMTP relay,
 * onboarding) must never wait behind a broadcast fan-out or a quota drain of
 * one, so bulk mail enqueues at 0 and transactional at 1.
 */
export const EMAIL_SEND_PRIORITY = { transactional: 1, bulk: 0 } as const;
export type EmailSendPriority = (typeof EMAIL_SEND_PRIORITY)[keyof typeof EMAIL_SEND_PRIORITY];

/** The priority an existing email row re-enqueues with: broadcast rows are bulk, everything else transactional. */
export const emailSendPriority = (email: { broadcastId: string | null }): EmailSendPriority =>
  email.broadcastId ? EMAIL_SEND_PRIORITY.bulk : EMAIL_SEND_PRIORITY.transactional;

/** One email.send in a batch enqueue; the wiring supplies the default priority. */
export interface EmailSendRequest {
  emailId: string;
  startAfter?: Date | undefined;
  priority?: EmailSendPriority | undefined;
}

/** The worker's seam for enqueueing a page of sends in one statement. */
export type EnqueueEmailSends = (batch: readonly EmailSendRequest[]) => Promise<void>;

/**
 * Job queues use the "short" policy: pg-boss only enforces singletonKey
 * uniqueness under short/singleton/stately/exclusive policies — on the
 * default "standard" policy the key is silently ignored and dedupe would be
 * a no-op. "short" + a key on every send = at most one CREATED job per key
 * (job_i1 is partial on state = created): an active job, or one waiting in
 * retry state, does not block a fresh insert. Dedupe therefore collapses
 * redeliveries only; anything that must run one at a time per key (a
 * webhook endpoint's drain passes) gets a `group` and a groupConcurrency 1
 * worker, which is what serialises them.
 */
const JOB_QUEUE_POLICY = "short" as const;

/**
 * Jobs that exhaust their retries are copied here instead of vanishing: the
 * dead-letter handler turns "gave up" into a terminal row state (email
 * failed, delivery exhausted) so the reconcile sweeps stop re-enqueueing
 * them. pg-boss enforces a FK from job.dead_letter to the queue table, so
 * the dead-letter queue must exist before the first send.
 */
export const DEAD_LETTER_QUEUES = {
  "email.send": "email.send.dead",
  "webhook.drain": "webhook.drain.dead",
  "recipient.erase": "recipient.erase.dead",
} as const;

export type DeadLetteredJobName = keyof typeof DEAD_LETTER_QUEUES;

const JOB_QUEUES = [
  "email.send",
  "broadcast.send",
  "ses.event",
  "webhook.drain",
  "recipient.erase",
] as const;
// Compile-time check that every JobPayloads key is listed above.
const _everyJobQueueListed: Record<Exclude<JobName, (typeof JOB_QUEUES)[number]>, never> = {};
void _everyJobQueueListed;

/**
 * Queues whose inserts NOTIFY the worker so a job runs the moment it lands;
 * polling stays on as the backstop. Erasure and the cron and dead-letter
 * queues are rare and never latency-sensitive, so they only poll, slowly.
 */
const NOTIFY_QUEUES: ReadonlySet<string> = new Set<JobName>([
  "email.send",
  "broadcast.send",
  "ses.event",
  "webhook.drain",
]);
const SLOW_POLL_SECONDS = 30;

/**
 * Jobs allowed to stay active longer than pg-boss's 15-minute default before
 * it retries them under a still-running handler. A broadcast fan-out walks
 * every contact in one job; an erasure scans a team's whole history.
 */
const EXPIRE_SECONDS: Partial<Record<JobName, number>> = {
  "broadcast.send": 6 * 3600,
  // Longest pg-boss allows short of a day: the handler does not watch the
  // abort signal, so an expiry must never fire under a scan still running.
  "recipient.erase": 23 * 3600,
};

/**
 * Finished jobs are history the queue never reads again; an hour keeps the
 * table small enough that the supervisor's per-minute counts stay cheap.
 */
const DELETE_AFTER_SECONDS = 3600;

const JOB_RETRY = { retryLimit: 10, retryBackoff: true, retryDelay: 5 } as const;

export const CRON_JOBS = {
  // Every 15 min: quota-parked emails drain back into the send queue as the
  // plan's UTC day rolls over or SES's rolling 24-hour window frees up.
  "quota.drain": "*/15 * * * *",
  // Every 15 min: re-enqueue accepted emails whose send job was lost.
  "sends.reconcile": "*/15 * * * *",
  // Hourly retention sweeps keep purge batches small.
  "retention.purge": "0 * * * *",
  "idempotency.purge": "30 * * * *",
  // Every 15 min: re-enqueue webhook deliveries whose job was lost.
  "webhooks.reconcile": "*/15 * * * *",
  // Every 15 min: re-enqueue broadcasts stuck in scheduled/sending.
  "broadcasts.reconcile": "*/15 * * * *",
  // Every 30 min: refresh the cached contact counts the Segments page shows.
  "segments.recount": "*/30 * * * *",
  // Every 15 min: re-check live DNS so a removed record demotes a verified
  // domain (blocking sends) without waiting for a page open.
  "domains.reverify": "*/15 * * * *",
  // Every 10 min: quota and deliverability notifications to team owners.
  "notifications.sweep": "*/10 * * * *",
  // Every 15 min: per-region platform breaker on the account-wide bounce/complaint rates.
  "platform.breaker": "*/15 * * * *",
  // Every 15 min: warn when sends went out but no SES event came back — a
  // broken event pipeline is otherwise silent (everything just reads "Sent").
  "events.health": "*/15 * * * *",
  // Hourly: associate domains with their team's SES tenant where the create-time
  // association is missing (pre-tenant rows, or a failed AWS call).
  "tenants.sync": "17 * * * *",
  // Hourly (cloud only): drop never-verified domains past SES's 72h DKIM
  // search window, freeing the (name, region) slot an unverified add would
  // otherwise squat forever. Offset from the other hourly sweeps.
  "domains.reap": "45 * * * *",
  // Daily: re-read each Stripe customer's subscription so a dropped webhook
  // cannot leave a team on the wrong plan. No-op off cloud.
  "billing.reconcile": "20 3 * * *",
} as const;

export type CronJobName = keyof typeof CRON_JOBS;

function deadLetterFor(name: JobName): string | undefined {
  return name in DEAD_LETTER_QUEUES ? DEAD_LETTER_QUEUES[name as DeadLetteredJobName] : undefined;
}

/**
 * `dedupeKey` is REQUIRED: on the short-policy queues it is the singletonKey
 * that collapses duplicates while a job is queued. `startAfter` defers the
 * job; `group` names the fairness group a worker's groupConcurrency caps.
 */
export interface JobSendOptions {
  dedupeKey: string;
  startAfter?: Date | undefined;
  priority?: number | undefined;
  group?: string | undefined;
}

/** What a handler learns about its job: pg-boss aborts the signal on shutdown and on expiry. */
export interface JobContext {
  signal: AbortSignal;
}

type JobHandler<N extends JobName> = (payload: JobPayloads[N], ctx: JobContext) => Promise<void>;

/**
 * pg-boss migrates its schema on start under an advisory lock with a 30 s
 * lock_timeout. A process booting beside the one migrating loses that race
 * with an error, and every process here boots at once, so a start that
 * fails is retried for a while instead of taking the process down.
 */
const START_ATTEMPTS = 12;
const START_RETRY_MS = 5_000;

async function startBoss(options: ConstructorParameters<typeof PgBoss>[0]): Promise<PgBoss> {
  for (let attempt = 1; ; attempt += 1) {
    const boss = new PgBoss(options);
    boss.on("error", (err: Error) => console.error("pg-boss error", err));
    boss.on("warning", (warning: { message: string; data: object }) =>
      console.warn("pg-boss warning", warning.message, warning.data),
    );
    try {
      await boss.start();
      return boss;
    } catch (err) {
      if (attempt >= START_ATTEMPTS) throw err;
      console.warn(
        `pg-boss start failed (attempt ${attempt}/${START_ATTEMPTS}), retrying in ${START_RETRY_MS / 1000}s:`,
        err instanceof Error ? err.message : err,
      );
      await new Promise((resolve) => setTimeout(resolve, START_RETRY_MS));
    }
  }
}

export class Queue {
  #producer: PgBoss;
  #consumer: PgBoss | undefined;
  #created = new Set<string>();
  // pg-boss's graceful stop waits for running handlers without aborting
  // their signal (it only aborts after failing them at the timeout), so a
  // long walk would never learn it should stop before the pools close.
  #shutdown = new AbortController();

  private constructor(producer: PgBoss, consumer?: PgBoss) {
    this.#producer = producer;
    this.#consumer = consumer;
  }

  /**
   * A producer-only process (api, smtp, web) holds two connections and never
   * supervises, schedules or polls; whichever process boots first migrates
   * (pg-boss holds an advisory lock around it). With `workers` the worker
   * gets two instances on one schema: the consumer owns every polling lane
   * plus maintenance and the cron clock, the producer owns every enqueue, so
   * a send never waits behind a fetch. Every static queue is created before
   * the first work() so registration never waits behind a backlog.
   */
  static async start(databaseUrl: string, opts: { workers?: boolean } = {}): Promise<Queue> {
    const base = { connectionString: databaseUrl, schema: "pgboss" };
    if (!opts.workers) {
      return new Queue(await startBoss({ ...base, supervise: false, schedule: false, max: 2 }));
    }
    // Maintenance every 10 minutes: pg-boss 12.30 runs one DELETE per chunk
    // of up to 100 queue names, unbounded by row count, so the pass stays
    // small only because retention does — finished jobs live an hour
    // (DELETE_AFTER_SECONDS), never-fetched ones pg-boss's 14-day default.
    // The queue monitor counts every five.
    const consumer = await startBoss({
      ...base,
      max: 8,
      maintenanceIntervalSeconds: 600,
      monitorIntervalSeconds: 300,
      useListenNotify: true,
    });
    const producer = await startBoss({
      ...base,
      supervise: false,
      schedule: false,
      migrate: false,
      max: 4,
    });
    const queue = new Queue(producer, consumer);
    for (const name of JOB_QUEUES) await queue.#prepare(name);
    for (const name of Object.keys(CRON_JOBS)) await queue.#ensureQueue(name);
    return queue;
  }

  get #workers(): PgBoss {
    if (!this.#consumer) {
      throw new Error("Queue.start(url, { workers: true }) is required before work()");
    }
    return this.#consumer;
  }

  async #ensureQueue(name: string, policy?: typeof JOB_QUEUE_POLICY): Promise<void> {
    if (this.#created.has(name)) return;
    const notify = NOTIFY_QUEUES.has(name);
    await this.#producer.createQueue(name, {
      ...(policy ? { policy } : {}),
      ...(notify ? { notify } : {}),
    });
    if (policy) {
      // createQueue is INSERT ... ON CONFLICT DO NOTHING: a pre-existing
      // queue keeps its stored policy, and pg-boss 12 cannot converge it —
      // updateQueue() throws "queue policy cannot be changed after creation"
      // (its UpdateQueueOptions omits `policy`). A queue left on "standard"
      // silently ignores singletonKey, turning dedupe into duplicate sends,
      // so a mismatch must fail loudly instead of degrading silently.
      const existing = await this.#producer.getQueue(name);
      if (existing && existing.policy !== policy) {
        throw new Error(
          `queue "${name}" has policy "${existing.policy}" but "${policy}" is required for ` +
            `singletonKey dedupe; pg-boss cannot change a queue's policy after creation — ` +
            `delete and recreate the queue`,
        );
      }
      // The notify flag, unlike the policy, can be converged on a queue
      // created before it existed.
      if (existing && notify && !existing.notify) {
        await this.#producer.updateQueue(name, { notify });
      }
    }
    this.#created.add(name);
  }

  /** Enqueue one job; see JobSendOptions. */
  async send<N extends JobName>(
    name: N,
    payload: JobPayloads[N],
    opts: JobSendOptions,
  ): Promise<string | null> {
    const deadLetter = await this.#prepare(name);
    return this.#producer.send(name, payload, this.#jobOptions(name, opts, deadLetter));
  }

  /**
   * Arm the drain of each endpoint. The key collapses a fan-out of any size
   * onto an endpoint whose drain is already created into no insert; a drain
   * that is running (or waiting in retry) gets a successor. The group is the
   * endpoint too: the webhook.drain worker runs with groupConcurrency 1, so
   * that successor is not fetched until the running pass has finished. Two
   * passes overlap only briefly when a retry job and a fresh one are fetched
   * by two lanes at once; the row lease keeps them on disjoint rows.
   */
  async drainWebhookEndpoints(endpointIds: readonly string[], startAfter?: Date): Promise<void> {
    await this.sendMany(
      "webhook.drain",
      [...new Set(endpointIds)].map((endpointId) => ({
        payload: { endpointId },
        dedupeKey: endpointId,
        group: endpointId,
        startAfter,
      })),
    );
  }

  /**
   * Enqueue many jobs of one queue in a single statement: a webhook fan-out
   * writes one job per endpoint, and a broadcast one per contact page.
   */
  async sendMany<N extends JobName>(
    name: N,
    jobs: readonly (JobSendOptions & { payload: JobPayloads[N] })[],
  ): Promise<void> {
    if (jobs.length === 0) return;
    const deadLetter = await this.#prepare(name);
    await this.#producer.insert(
      name,
      jobs.map(({ payload, ...opts }) => ({
        data: payload,
        ...this.#jobOptions(name, opts, deadLetter),
      })),
    );
  }

  async #prepare(name: JobName): Promise<string | undefined> {
    await this.#ensureQueue(name, JOB_QUEUE_POLICY);
    const deadLetter = deadLetterFor(name);
    if (deadLetter) await this.#ensureQueue(deadLetter);
    return deadLetter;
  }

  #jobOptions(name: JobName, opts: JobSendOptions, deadLetter: string | undefined) {
    const expireInSeconds = EXPIRE_SECONDS[name];
    return {
      singletonKey: opts.dedupeKey,
      ...(opts.startAfter ? { startAfter: opts.startAfter } : {}),
      ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
      ...(opts.group ? { group: { id: opts.group } } : {}),
      ...(deadLetter ? { deadLetter } : {}),
      ...(expireInSeconds ? { expireInSeconds } : {}),
      deleteAfterSeconds: DELETE_AFTER_SECONDS,
      ...JOB_RETRY,
    };
  }

  /**
   * `concurrency` spawns that many independent pg-boss workers for the queue
   * in this process, so one slow job (a stalling webhook receiver) cannot
   * serialize everyone else's. It is not a rate limit.
   *
   * A worker sleeps `pollingIntervalSeconds` (pg-boss default 2) between
   * fetches unless the last fetch came back full, and a batch of one never
   * counts as full: at batchSize 1 each worker moves at most one job every
   * two seconds however long the backlog. Queues that see bursts fetch a
   * `batchSize` above one, which turns on continuous fetching while the
   * backlog lasts; the handler still runs the batch one job at a time.
   *
   * On a notify queue pg-boss relaxes the poll to a 30 s backstop by default,
   * and NOTIFY fires only on insert: a job that becomes due later (a drip
   * startAfter, a retry backoff, a drain re-arm) would wait up to 30 s. The
   * notify interval is pinned to the base interval so NOTIFY only ever
   * shortens latency.
   */
  async work<N extends JobName>(
    name: N,
    handler: JobHandler<N>,
    opts: {
      batchSize?: number;
      concurrency?: number;
      pollingIntervalSeconds?: number;
      /**
       * Cap on jobs of one `group` (see JobSendOptions) running at once across
       * every worker process, enforced in the fetch itself, so one slow
       * receiver cannot occupy every lane and no fetched job waits on an
       * in-memory limiter.
       */
      groupConcurrency?: number;
    } = {},
  ): Promise<void> {
    await this.#ensureQueue(name, JOB_QUEUE_POLICY);
    const batchSize = opts.batchSize ?? 1;
    await this.#workers.work<JobPayloads[N]>(
      name,
      {
        batchSize,
        localConcurrency: opts.concurrency ?? 1,
        burstWhenBatchFull: batchSize > 1,
        ...(opts.pollingIntervalSeconds !== undefined
          ? { pollingIntervalSeconds: opts.pollingIntervalSeconds }
          : {}),
        notifyPollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2,
        ...(opts.groupConcurrency !== undefined ? { groupConcurrency: opts.groupConcurrency } : {}),
      },
      (jobs: { data: JobPayloads[N]; signal: AbortSignal }[]) => this.#run(handler, jobs),
    );
  }

  /** Runs a batch one job at a time; the signal aborts on the job's own signal or on stop(). */
  async #run<N extends JobName>(
    handler: JobHandler<N>,
    jobs: { data: JobPayloads[N]; signal: AbortSignal }[],
  ): Promise<void> {
    for (const job of jobs) {
      await handler(job.data, { signal: AbortSignal.any([job.signal, this.#shutdown.signal]) });
    }
  }

  /** Handles jobs that exhausted their retries on `name` (payload unchanged). */
  async workDeadLetter<N extends DeadLetteredJobName>(
    name: N,
    handler: JobHandler<N>,
  ): Promise<void> {
    const deadLetter = DEAD_LETTER_QUEUES[name];
    await this.#ensureQueue(deadLetter);
    await this.#workers.work<JobPayloads[N]>(
      deadLetter,
      { batchSize: 1, pollingIntervalSeconds: SLOW_POLL_SECONDS },
      (jobs: { data: JobPayloads[N]; signal: AbortSignal }[]) => this.#run(handler, jobs),
    );
  }

  async scheduleCrons(handlers: Record<CronJobName, () => Promise<void>>): Promise<void> {
    for (const [name, cron] of Object.entries(CRON_JOBS) as [CronJobName, string][]) {
      await this.#ensureQueue(name);
      await this.#producer.schedule(name, cron, {}, { tz: "UTC" });
      await this.#workers.work(
        name,
        { batchSize: 1, pollingIntervalSeconds: SLOW_POLL_SECONDS },
        async () => {
          await handlers[name]();
        },
      );
    }
  }

  /**
   * Runs a cron job ahead of its schedule. Cron queues use the standard
   * policy, so a run already queued is not collapsed; every cron handler is
   * idempotent, so an extra run only costs a query.
   */
  async runCronNow(name: CronJobName): Promise<void> {
    await this.#ensureQueue(name);
    await this.#producer.send(name, {});
  }

  /**
   * Handlers learn first, so a walk can end at its next page instead of
   * running into pg-boss's stop timeout; then the consumer drains, and the
   * producer closes last so a handler finishing its page can still enqueue.
   */
  async stop(): Promise<void> {
    this.#shutdown.abort();
    await this.#consumer?.stop({ graceful: true });
    await this.#producer.stop({ graceful: true });
  }
}
