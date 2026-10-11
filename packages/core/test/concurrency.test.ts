import { expect, it } from "vitest";
import { createSemaphore } from "../src/concurrency.js";

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
