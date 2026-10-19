import { createCallerFactory, router } from "../trpc";
import { apiKeysRouter } from "./api-keys";
import { audienceRouter } from "./audience";
import { auditRouter } from "./audit";
import { billingRouter } from "./billing";
import { broadcastsRouter } from "./broadcasts";
import { connectedAppsRouter } from "./connected-apps";
import { consoleRouter } from "./console";
import { domainsRouter } from "./domains";
import { emailRouter } from "./email";
import { emailsRouter } from "./emails";
import { inboxesRouter } from "./inboxes";
import { logsRouter } from "./logs";
import { metricsRouter } from "./metrics";
import { onboardingRouter } from "./onboarding";
import { receivingRouter } from "./receiving";
import { segmentsRouter } from "./segments";
import { settingsRouter } from "./settings";
import { supportRouter } from "./support";
import { systemRouter } from "./system";
import { teamBootstrapRouter } from "./team-bootstrap";
import { templatesRouter } from "./templates";
import { topicsRouter } from "./topics";
import { webhooksRouter } from "./webhooks";

export const appRouter = router({
  audience: audienceRouter,
  audit: auditRouter,
  billing: billingRouter,
  broadcasts: broadcastsRouter,
  connectedApps: connectedAppsRouter,
  console: consoleRouter,
  email: emailRouter,
  emails: emailsRouter,
  domains: domainsRouter,
  apiKeys: apiKeysRouter,
  inboxes: inboxesRouter,
  logs: logsRouter,
  metrics: metricsRouter,
  onboarding: onboardingRouter,
  receiving: receivingRouter,
  segments: segmentsRouter,
  settings: settingsRouter,
  support: supportRouter,
  system: systemRouter,
  team: teamBootstrapRouter,
  templates: templatesRouter,
  topics: topicsRouter,
  webhooks: webhooksRouter,
});

export type AppRouter = typeof appRouter;

/** For tests: build a caller from a faked Context. */
export const createCaller = createCallerFactory(appRouter);
