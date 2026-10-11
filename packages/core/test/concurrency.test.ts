import { expect, it } from "vitest";
import { createSemaphore, releasingStream } from "../src/concurrency.js";

it("never runs more than its limit at once, and runs waiters in arrival order", async () => {
  const run = createSemaphore(2);
  let active = 0;
  let peak = 0;
  const order: number[] = [];
  const task = (n: number) =>
    run(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(n);
      active--;
      return n;
    });
  const results = await Promise.all([1, 2, 3, 4, 5].map(task));
  expect(results).toEqual([1, 2, 3, 4, 5]);
  expect(peak).toBe(2);
  expect(order.slice(2)).toEqual([3, 4, 5]);
});

it("releases the slot when a task throws", async () => {
  const run = createSemaphore(1);
  await expect(run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  await expect(run(async () => "next")).resolves.toBe("next");
});

it("streams bytes in chunks and releases once, at the end, a cancel, an abort or the cap", async () => {
  const bytes = new Uint8Array(10).map((_, i) => i);
  let released = 0;
  const release = () => released++;

  const read = releasingStream(bytes, release, { maxHoldMs: 60_000, chunkBytes: 4 }).getReader();
  const chunks: number[][] = [];
  for (let r = await read.read(); !r.done; r = await read.read()) {
    expect(released).toBe(0);
    chunks.push([...r.value]);
  }
  expect(chunks).toEqual([
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    [8, 9],
  ]);
  expect(released).toBe(1);

  const cancelled = releasingStream(bytes, release, { maxHoldMs: 60_000, chunkBytes: 4 });
  await cancelled.getReader().cancel();
  expect(released).toBe(2);

  const aborts = new AbortController();
  const abandoned = releasingStream(bytes, release, { signal: aborts.signal, maxHoldMs: 60_000 });
  aborts.abort();
  await abandoned.cancel();
  expect(released).toBe(3);

  releasingStream(bytes, release, { maxHoldMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(released).toBe(4);
});
