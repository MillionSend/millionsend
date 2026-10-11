/**
 * Runs at most `max` tasks at once; the rest wait their turn in arrival
 * order. A finishing task hands its slot straight to the next waiter, so a
 * newcomer can never slip in between and push the count past `max`.
 */
export function createSemaphore(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
