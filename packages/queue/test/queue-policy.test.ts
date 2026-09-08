import { beforeEach, expect, it, vi } from "vitest";
import { CRON_JOBS, DEAD_LETTER_QUEUES, Queue } from "../src/index.js";

// In-memory stand-in for pg-boss's queue table. createQueue mirrors the real
// implementation's INSERT ... ON CONFLICT DO NOTHING: a pre-existing queue
// keeps its stored policy (and notify flag) no matter what the caller asks for.
const queues = new Map<string, { policy: string; notify: boolean }>();
const sent: {
  name: string;
  opts: Record<string, unknown>;
}[] = [];
type Handler = (jobs: { data: unknown; signal: AbortSignal }[]) => Promise<void>;
const workers: { name: string; opts: Record<string, unknown>; handler: Handler; boss: number }[] =
  [];
const inserted: { name: string; job: Record<string, unknown> }[] = [];
const updated: { name: string; opts: Record<string, unknown> }[] = [];
const scheduled: string[] = [];
const bosses: { options: Record<string, unknown>; events: string[]; stopped: boolean }[] = [];
let createQueueError: Error | undefined;

vi.mock("pg-boss", () => ({
  PgBoss: class {
    #index: number;
    constructor(options: Record<string, unknown>) {
      this.#index = bosses.push({ options, events: [], stopped: false }) - 1;
    }
    on(event: string): void {
      bosses[this.#index]?.events.push(event);
    }
    async start(): Promise<void> {}
    async stop(): Promise<void> {
      const boss = bosses[this.#index];
      if (boss) boss.stopped = true;
    }
    async createQueue(
      name: string,
      options?: { policy?: string; notify?: boolean },
    ): Promise<void> {
      if (createQueueError) throw createQueueError;
      if (!queues.has(name)) {
        queues.set(name, {
          policy: options?.policy ?? "standard",
          notify: options?.notify ?? false,
        });
      }
    }
    async updateQueue(name: string, opts: Record<string, unknown>): Promise<void> {
      updated.push({ name, opts });
      const q = queues.get(name);
      if (q && typeof opts.notify === "boolean") q.notify = opts.notify;
    }
    async getQueue(
      name: string,
    ): Promise<{ name: string; policy: string; notify: boolean } | null> {
      const q = queues.get(name);
      return q ? { name, ...q } : null;
    }
    async send(name: string, _data: unknown, opts: Record<string, unknown>): Promise<string> {
      sent.push({ name, opts });
      return "job-1";
    }
    async schedule(name: string): Promise<void> {
      scheduled.push(name);
    }
    async work(name: string, opts: Record<string, unknown>, handler: Handler): Promise<string> {
      workers.push({ name, opts, handler, boss: this.#index });
      return "worker-1";
    }
    async insert(name: string, jobs: Record<string, unknown>[]): Promise<void> {
      for (const job of jobs) inserted.push({ name, job });
    }
  },
}));

beforeEach(() => {
  queues.clear();
  sent.length = 0;
  workers.length = 0;
  inserted.length = 0;
  updated.length = 0;
  scheduled.length = 0;
  bosses.length = 0;
  createQueueError = undefined;
});

const startWorker = () => Queue.start("postgres://unused", { workers: true });

it("a producer-only process gets one small instance that neither supervises nor schedules, and cannot work()", async () => {
  const queue = await Queue.start("postgres://unused");
  expect(bosses).toHaveLength(1);
  expect(bosses[0]?.options).toMatchObject({
    schema: "pgboss",
    supervise: false,
    schedule: false,
    max: 2,
  });
  expect(bosses[0]?.options).not.toHaveProperty("migrate");
  expect(bosses[0]?.events).toEqual(["error", "warning"]);
  // Nothing is pre-created: a producer creates a queue on its first send.
  expect(queues.size).toBe(0);
  await expect(queue.work("email.send", async () => {})).rejects.toThrow(/workers: true/);
});

it("the worker starts a migrating, listening consumer first and a producer second, and pre-creates every static queue", async () => {
  await startWorker();
  expect(bosses).toHaveLength(2);
  expect(bosses[0]?.options).toMatchObject({
    max: 8,
    monitorIntervalSeconds: 300,
    maintenanceIntervalSeconds: 600,
    useListenNotify: true,
  });
  expect(bosses[0]?.options).not.toHaveProperty("supervise");
  expect(bosses[1]?.options).toMatchObject({
    max: 4,
    supervise: false,
    schedule: false,
    migrate: false,
  });
  for (const name of [
    "email.send",
    "broadcast.send",
    "ses.event",
    "webhook.drain",
    "recipient.erase",
  ]) {
    expect(queues.get(name)).toEqual({ policy: "short", notify: name !== "recipient.erase" });
  }
  for (const name of Object.values(DEAD_LETTER_QUEUES)) {
    expect(queues.get(name)).toEqual({ policy: "standard", notify: false });
  }
  for (const name of Object.keys(CRON_JOBS)) {
    expect(queues.get(name)).toEqual({ policy: "standard", notify: false });
  }
  expect(workers).toHaveLength(0);
});

it("work() registers on the consumer, sends go through the producer, and stop() stops both", async () => {
  const queue = await startWorker();
  await queue.work("email.send", async () => {});
  expect(workers[0]?.boss).toBe(0);
  await queue.send("email.send", { emailId: "e1" }, { dedupeKey: "e1" });
  expect(sent).toHaveLength(1);
  await queue.stop();
  expect(bosses.map((b) => b.stopped)).toEqual([true, true]);
});

it("turns notify on for a queue that predates the flag, and never for the ones that only poll", async () => {
  queues.set("email.send", { policy: "short", notify: false });
  queues.set("recipient.erase", { policy: "short", notify: false });
  await startWorker();
  expect(updated).toEqual([{ name: "email.send", opts: { notify: true } }]);
  expect(queues.get("email.send")?.notify).toBe(true);
});

it("a failing createQueue fails boot loudly instead of being swallowed", async () => {
  createQueueError = new Error("permission denied for schema pgboss");
  await expect(startWorker()).rejects.toThrow(/permission denied/);
});

it("hands the handler the job's abort signal", async () => {
  const queue = await startWorker();
  const seen: { payload: unknown; aborted: boolean }[] = [];
  await queue.work("broadcast.send", async (payload, ctx) => {
    seen.push({ payload, aborted: ctx.signal.aborted });
  });
  const ac = new AbortController();
  ac.abort();
  await workers[0]?.handler([
    { data: { broadcastId: "b1" }, signal: new AbortController().signal },
    { data: { broadcastId: "b2" }, signal: ac.signal },
  ]);
  expect(seen).toEqual([
    { payload: { broadcastId: "b1" }, aborted: false },
    { payload: { broadcastId: "b2" }, aborted: true },
  ]);
});

it("cron and dead-letter workers poll slowly; crons are scheduled through the producer", async () => {
  const queue = await startWorker();
  await queue.workDeadLetter("email.send", async () => {});
  expect(workers[0]).toMatchObject({
    name: "email.send.dead",
    opts: { batchSize: 1, pollingIntervalSeconds: 30 },
    boss: 0,
  });
  const handlers = Object.fromEntries(
    Object.keys(CRON_JOBS).map((name) => [name, async () => {}]),
  ) as Parameters<Queue["scheduleCrons"]>[0];
  await queue.scheduleCrons(handlers);
  expect(scheduled).toEqual(Object.keys(CRON_JOBS));
  const cronWorkers = workers.slice(1);
  expect(cronWorkers.map((w) => w.name)).toEqual(Object.keys(CRON_JOBS));
  expect(cronWorkers.every((w) => w.opts.pollingIntervalSeconds === 30 && w.boss === 0)).toBe(true);
});

it("creates job queues with the dedupe-enforcing policy", async () => {
  const queue = await Queue.start("postgres://unused");
  await queue.send("email.send", { emailId: "e1" }, { dedupeKey: "e1" });
  expect(queues.get("email.send")).toEqual({ policy: "short", notify: true });
  expect(sent[0]?.opts.singletonKey).toBe("e1");
});

it("fails loudly when a pre-existing queue has a policy that ignores singletonKey", async () => {
  queues.set("email.send", { policy: "standard", notify: false });
  const queue = await Queue.start("postgres://unused");
  await expect(queue.send("email.send", { emailId: "e1" }, { dedupeKey: "e1" })).rejects.toThrow(
    /policy/,
  );
  // The job was never enqueued — silent duplicate sends are worse than a 500.
  expect(sent).toHaveLength(0);
});

it("routes retry-exhausted send and delivery jobs to a dead-letter queue that exists first", async () => {
  const queue = await Queue.start("postgres://unused");
  await queue.send("email.send", { emailId: "e1" }, { dedupeKey: "e1" });
  await queue.send("ses.event", { event: {} as never, snsMessageId: "s1" }, { dedupeKey: "s1" });
  expect(queues.has("email.send.dead")).toBe(true);
  expect(sent[0]?.opts).toMatchObject({ deadLetter: "email.send.dead" });
  // Event ingestion has no terminal row state to record; no dead letter there.
  expect(sent[1]?.opts).not.toHaveProperty("deadLetter");
});

it("forwards a job priority so transactional sends fetch ahead of bulk ones", async () => {
  const queue = await Queue.start("postgres://unused");
  await queue.send("email.send", { emailId: "tx" }, { dedupeKey: "tx", priority: 1 });
  await queue.send("email.send", { emailId: "bulk" }, { dedupeKey: "bulk" });
  expect(sent.map((s) => s.opts.priority)).toEqual([1, undefined]);
});

it("fetches bursty queues continuously: a batch above one turns burst mode on, a batch of one leaves it off", async () => {
  const queue = await startWorker();
  await queue.work("ses.event", async () => {}, { batchSize: 10, concurrency: 4 });
  await queue.work("webhook.drain", async () => {}, {
    concurrency: 8,
    pollingIntervalSeconds: 1,
  });
  expect(workers.map((w) => ({ name: w.name, opts: w.opts }))).toEqual([
    {
      name: "ses.event",
      opts: { batchSize: 10, localConcurrency: 4, burstWhenBatchFull: true },
    },
    {
      name: "webhook.drain",
      opts: {
        batchSize: 1,
        localConcurrency: 8,
        burstWhenBatchFull: false,
        pollingIntervalSeconds: 1,
      },
    },
  ]);
});

it("caps a fairness group per process when asked", async () => {
  const queue = await startWorker();
  await queue.work("ses.event", async () => {}, {
    concurrency: 16,
    batchSize: 2,
    groupConcurrency: 2,
  });
  expect(workers.at(-1)?.opts).toEqual({
    batchSize: 2,
    localConcurrency: 16,
    burstWhenBatchFull: true,
    groupConcurrency: 2,
  });
});

it("sends many jobs in one statement with the same policy as single sends, plus group and expiry", async () => {
  const queue = await Queue.start("postgres://unused");
  await queue.sendMany("recipient.erase", [
    { payload: { teamId: "t", address: "a" }, dedupeKey: "t:a", group: "team-a" },
    {
      payload: { teamId: "t", address: "b" },
      dedupeKey: "t:b",
      group: "team-b",
      startAfter: new Date(0),
    },
  ]);
  expect(inserted.map((i) => i.name)).toEqual(["recipient.erase", "recipient.erase"]);
  expect(inserted[0]?.job).toMatchObject({
    data: { teamId: "t", address: "a" },
    singletonKey: "t:a",
    group: { id: "team-a" },
    deadLetter: "recipient.erase.dead",
    deleteAfterSeconds: 3600,
    retryLimit: 10,
  });
  expect(inserted[1]?.job).toMatchObject({ startAfter: new Date(0) });
  await queue.sendMany("email.send", []);
  expect(inserted).toHaveLength(2);

  await queue.send("broadcast.send", { broadcastId: "b" }, { dedupeKey: "b" });
  expect(sent.at(-1)?.opts).toMatchObject({ expireInSeconds: 6 * 3600, deleteAfterSeconds: 3600 });
  await queue.send("email.send", { emailId: "e" }, { dedupeKey: "e" });
  expect(sent.at(-1)?.opts).not.toHaveProperty("expireInSeconds");
});

it("a batch of sends carries the same options as a single send: key, priority, deadLetter, drip", async () => {
  const queue = await Queue.start("postgres://unused");
  const at = new Date(1_000);
  await queue.sendMany("email.send", [
    { payload: { emailId: "e1" }, dedupeKey: "e1", priority: 0 },
    { payload: { emailId: "e2" }, dedupeKey: "e2", priority: 0, startAfter: at },
  ]);
  await queue.send(
    "email.send",
    { emailId: "e3" },
    { dedupeKey: "e3", priority: 0, startAfter: at },
  );
  const { data: _data, ...batchOpts } = inserted[1]?.job ?? {};
  expect(batchOpts).toEqual({ ...sent[0]?.opts, singletonKey: "e2" });
  expect(batchOpts).toMatchObject({
    priority: 0,
    startAfter: at,
    deadLetter: "email.send.dead",
    retryLimit: 10,
    retryBackoff: true,
    retryDelay: 5,
  });
  expect(inserted[0]?.job).not.toHaveProperty("startAfter");
});

it("arms one drain per distinct endpoint, keyed by the endpoint so a queued one absorbs the rest", async () => {
  const queue = await Queue.start("postgres://unused");
  const at = new Date(0);
  await queue.drainWebhookEndpoints(["ep-a", "ep-b", "ep-a", "ep-a"], at);
  expect(inserted.map((i) => i.name)).toEqual(["webhook.drain", "webhook.drain"]);
  expect(inserted.map((i) => i.job)).toEqual([
    expect.objectContaining({
      data: { endpointId: "ep-a" },
      singletonKey: "ep-a",
      startAfter: at,
      deadLetter: "webhook.drain.dead",
    }),
    expect.objectContaining({ data: { endpointId: "ep-b" }, singletonKey: "ep-b" }),
  ]);
  expect(inserted[0]?.job).not.toHaveProperty("group");
  expect(inserted[0]?.job).not.toHaveProperty("priority");
  expect(queues.get("webhook.drain")).toEqual({ policy: "short", notify: true });

  await queue.drainWebhookEndpoints([]);
  expect(inserted).toHaveLength(2);
});
