import { existsSync, writeFileSync } from "node:fs";

// The first boot fails, as a thread whose WASM won't load would; the marker
// file the test names records it, and every later thread boots as the hang thread.
const marker = process.env.MEDIA_BOOT_MARKER;
if (!existsSync(marker)) {
  writeFileSync(marker, "");
  throw new Error("boot failed");
}
await import("./hang-thread.mjs");
