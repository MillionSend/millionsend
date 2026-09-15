import { router } from "../../trpc";
import { consoleAuditRouter } from "./audit";
import { consoleOverviewRouter } from "./overview";
import { consoleRegionsRouter } from "./regions";
import { consoleSafetyRouter } from "./safety";
import { consoleTeamsRouter } from "./teams";

/** The instance operator's console: every procedure is an operatorProcedure. */
export const consoleRouter = router({
  overview: consoleOverviewRouter,
  regions: consoleRegionsRouter,
  teams: consoleTeamsRouter,
  safety: consoleSafetyRouter,
  audit: consoleAuditRouter,
});
