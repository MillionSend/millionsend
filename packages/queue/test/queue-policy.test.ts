import { beforeEach, expect, it, vi } from "vitest";
import { Queue } from "../src/index.js";

// In-memory stand-in for pg-boss's queue table. createQueue mirrors the real
// implementation's INSERT ... ON CONFLICT DO NOTHING: a pre-existing queue
// keeps its stored policy no matter what the caller asks for.
const queues = new Map<string, { policy: string }>();
const sent: {
  name: string;
  opts: Record<string, unknown>;
}[] = [];
const workers: { name: string; opts: Record<string, unknown> }[] = [];
const inserted: { name: string; job: Record<string, unknown> }[] = [];

vi.mock("pg-boss", () => ({
  PgBoss: class {
    on(): void {}
    async start(): Promise<void> {}
    async createQueue(name: string, options?: { policy?: string }): Promise<void> {
      if (!queues.has(name)) queues.set(name, { policy: options?.policy ?? "standard" });
    }
    async getQueue(name: string): Promise<{ name: string; policy: string } | null> {
      const q = queues.get(name);
      return q ? { name, policy: q.policy } : null;
    }
    async send(name: string, _data: unknown, opts: Record<string, unknown>): Promise<string> {
      sent.push({ name, opts });
      return "job-1";
    }
    async work(name: string, opts: Record<string, unknown>): Promise<string> {
      workers.push({ name, opts });
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
});

it("creates job queues with the dedupe-enforcing policy", async () => {
  const queue = await Queue.start("postgres://unused");
  await queue.send("email.send", { emailId: "e1" }, { dedupeKey: "e1" });
  expect(queues.get("email.send")).toEqual({ policy: "short" });
  expect(sent[0]?.opts.singletonKey).toBe("e1");
});

it("fails loudly when a pre-existing queue has a policy that ignores singletonKey", async () => {
  queues.set("email.send", { policy: "standard" });
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
  const queue = await Queue.start("postgres://unused");
  await queue.work("ses.event", async () => {}, { batchSize: 10, concurrency: 4 });
  await queue.work("webhook.deliver", async () => {}, {
    concurrency: 8,
    pollingIntervalSeconds: 1,
  });
  expect(workers).toEqual([
    {
      name: "ses.event",
      opts: { batchSize: 10, localConcurrency: 4, burstWhenBatchFull: true },
    },
    {
      name: "webhook.deliver",
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
  const queue = await Queue.start("postgres://unused");
  await queue.work("webhook.deliver", async () => {}, {
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
  await queue.sendMany("webhook.deliver", [
    { payload: { deliveryId: "d1" }, dedupeKey: "d1", group: "endpoint-a" },
    {
      payload: { deliveryId: "d2" },
      dedupeKey: "d2",
      group: "endpoint-b",
      startAfter: new Date(0),
    },
  ]);
  expect(inserted.map((i) => i.name)).toEqual(["webhook.deliver", "webhook.deliver"]);
  expect(inserted[0]?.job).toMatchObject({
    data: { deliveryId: "d1" },
    singletonKey: "d1",
    group: { id: "endpoint-a" },
    deadLetter: "webhook.deliver.dead",
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
