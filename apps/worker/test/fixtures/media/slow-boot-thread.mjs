import { setTimeout as sleep } from "node:timers/promises";

// The hang thread, ready only after a boot slower than the tests' parse budget.
await sleep(1_500);
await import("./hang-thread.mjs");
