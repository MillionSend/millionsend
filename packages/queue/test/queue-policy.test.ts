import { beforeEach, expect, it, vi } from "vitest";
import { Queue } from "../src/index.js";

// In-memory stand-in for pg-boss's queue table. createQueue mirrors the real
// implementation's INSERT ... ON CONFLICT DO NOTHING: a pre-existing queue
// keeps its stored policy no matter what the caller asks for.
const queues = new Map<string, { policy: string }>();
const sent: { name: string; opts: { singletonKey?: string; deadLetter?: string } }[] = [];

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
    async send(
      name: string,
      _data: unknown,
      opts: { singletonKey?: string; deadLetter?: string },
    ): Promise<string> {
      sent.push({ name, opts });
      return "job-1";
    }
  },
}));

beforeEach(() => {
  queues.clear();
  sent.length = 0;
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
