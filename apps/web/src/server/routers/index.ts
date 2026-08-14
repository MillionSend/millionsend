import { createCallerFactory, router } from "../trpc";
import { apiKeysRouter } from "./api-keys";
import { domainsRouter } from "./domains";
import { emailsRouter } from "./emails";
import { settingsRouter } from "./settings";
import { teamBootstrapRouter } from "./team-bootstrap";

export const appRouter = router({
  emails: emailsRouter,
  domains: domainsRouter,
  apiKeys: apiKeysRouter,
  settings: settingsRouter,
  team: teamBootstrapRouter,
});

export type AppRouter = typeof appRouter;

/** For tests: build a caller from a faked Context. */
export const createCaller = createCallerFactory(appRouter);
