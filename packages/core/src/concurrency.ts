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

/**
 * `bytes` as a stream of chunks (views, never copies) that calls `release`
 * once: when it has been read to the end, cancelled, `signal` aborted (the
 * client left before anything read it), or `maxHoldMs` passed. A semaphore
 * slot held until then bounds the bodies in flight by the slots however
 * slowly clients read, since a writer that waits for drain pulls a chunk only
 * when the last one left.
 */
export function releasingStream(
  bytes: Uint8Array,
  release: () => void,
  options: { signal?: AbortSignal; maxHoldMs: number; chunkBytes?: number },
): ReadableStream<Uint8Array> {
  const chunkBytes = options.chunkBytes ?? 64 * 1024;
  let offset = 0;
  let held = true;
  const done = () => {
    if (!held) return;
    held = false;
    clearTimeout(cap);
    options.signal?.removeEventListener("abort", done);
    release();
  };
  const cap = setTimeout(done, options.maxHoldMs);
  cap.unref();
  if (options.signal?.aborted) done();
  else options.signal?.addEventListener("abort", done, { once: true });
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          done();
          return;
        }
        controller.enqueue(bytes.subarray(offset, offset + chunkBytes));
        offset += chunkBytes;
      },
      cancel: done,
    },
    { highWaterMark: 0 },
  );
}
