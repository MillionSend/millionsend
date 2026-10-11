import { parseMxEnv } from "./env.js";
import { createMxServer, log } from "./mx.js";

// Throws on missing or partial configuration, so boot fails before any
// listener starts.
const env = parseMxEnv(process.env);
const mx = createMxServer(env);

// A listener that cannot bind (or later breaks) takes the process down, so
// the container restarts instead of idling without a port.
mx.smtp.server.once("error", (err) => {
  log("listen_failed", { port: env.port, error: err });
  process.exit(1);
});
mx.smtp.listen(env.port, () => {
  log("listening", { port: env.port, hostname: env.hostname });
});

// In-flight sessions get up to 30 s (smtp-server's close timeout) to finish;
// stragglers then hear 421 and retry, and the app dedupes any repeat.
const shutdown = () => {
  log("shutting_down");
  void mx.close().then(() => process.exit(0));
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
