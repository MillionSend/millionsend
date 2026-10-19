import { router } from "../../trpc";
import { consoleAccountsRouter } from "./accounts";
import { consoleAuditRouter } from "./audit";
import { consoleMonitorRouter } from "./monitor";
import { consoleOverviewRouter } from "./overview";
import { consoleRegionsRouter } from "./regions";
import { consoleSafetyRouter } from "./safety";
import { consoleTeamsRouter } from "./teams";

/** The instance operator's console: every procedure is an operatorProcedure. */
export const consoleRouter = router({
  overview: consoleOverviewRouter,
  regions: consoleRegionsRouter,
  teams: consoleTeamsRouter,
  accounts: consoleAccountsRouter,
  safety: consoleSafetyRouter,
  monitor: consoleMonitorRouter,
  audit: consoleAuditRouter,
});
