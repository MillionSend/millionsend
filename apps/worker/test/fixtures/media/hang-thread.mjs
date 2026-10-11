import { parentPort, threadId } from "node:worker_threads";

// Speaks the media pool's protocol: "hang" spins like a stuck parser, "crash"
// ends the thread, "grow" reports a WASM heap past any limit, anything else
// is echoed back with the thread's id.
parentPort?.on("message", (message) => {
  if (message === "crash") process.exit(1);
  let spins = 0;
  while (message === "hang") spins++;
  parentPort?.postMessage({
    ok: true,
    result: { message, spins, threadId },
    wasmBytes: message === "grow" ? Number.MAX_SAFE_INTEGER : 0,
  });
});
