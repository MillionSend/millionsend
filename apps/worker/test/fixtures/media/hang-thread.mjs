import { parentPort } from "node:worker_threads";

// Speaks the media pool's protocol: "hang" spins like a stuck parser, "crash"
// ends the thread, anything else is echoed back.
parentPort?.on("message", (message) => {
  if (message === "crash") process.exit(1);
  let spins = 0;
  while (message === "hang") spins++;
  parentPort?.postMessage({ ok: true, result: { message, spins } });
});
