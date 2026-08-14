import { createCallerFactory, router } from "../trpc";
import { apiKeysRouter } from "./api-keys";
import { domainsRouter } from "./domains";
import { emailsRouter } from "./emails";
import { metricsRouter } from "./metrics";
import { settingsRouter } from "./settings";
import { systemRouter } from "./system";
import { teamBootstrapRouter } from "./team-bootstrap";

export const appRouter = router({
  emails: emailsRouter,
  domains: domainsRouter,
  apiKeys: apiKeysRouter,
  metrics: metricsRouter,
  settings: settingsRouter,
  system: systemRouter,
  team: teamBootstrapRouter,
});

export type AppRouter = typeof appRouter;

/** For tests: build a caller from a faked Context. */
export const createCaller = createCallerFactory(appRouter);
