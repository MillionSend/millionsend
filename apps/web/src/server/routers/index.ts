import { createCallerFactory, router } from "../trpc";
import { apiKeysRouter } from "./api-keys";
import { audienceRouter } from "./audience";
import { auditRouter } from "./audit";
import { billingRouter } from "./billing";
import { broadcastsRouter } from "./broadcasts";
import { connectedAppsRouter } from "./connected-apps";
import { domainsRouter } from "./domains";
import { emailRouter } from "./email";
import { emailsRouter } from "./emails";
import { logsRouter } from "./logs";
import { metricsRouter } from "./metrics";
import { onboardingRouter } from "./onboarding";
import { segmentsRouter } from "./segments";
import { settingsRouter } from "./settings";
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
  email: emailRouter,
  emails: emailsRouter,
  domains: domainsRouter,
  apiKeys: apiKeysRouter,
  logs: logsRouter,
  metrics: metricsRouter,
  onboarding: onboardingRouter,
  segments: segmentsRouter,
  settings: settingsRouter,
  system: systemRouter,
  team: teamBootstrapRouter,
  templates: templatesRouter,
  topics: topicsRouter,
  webhooks: webhooksRouter,
});

export type AppRouter = typeof appRouter;

/** For tests: build a caller from a faked Context. */
export const createCaller = createCallerFactory(appRouter);
