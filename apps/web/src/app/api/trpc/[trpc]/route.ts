import { captureError } from "@millionsend/core/error-tracking-node";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appOrigin } from "@/lib/api-base-url";
import { isCrossOriginMutation } from "@/lib/http-url";
import { appRouter } from "@/server/routers";
import { createContext } from "@/server/trpc";

// Every response is per-user: keep it out of shared caches and bfcache.
const RESPONSE_HEADERS = { "cache-control": "private, no-store" };

const handler = (req: Request) => {
  if (isCrossOriginMutation(req, appOrigin())) return new Response(null, { status: 403 });
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createContext({ headers: req.headers }),
    responseMeta: () => ({ headers: RESPONSE_HEADERS }),
    // Faults only: a thrown TRPCError with any other code is an answer the
    // procedure chose. The input never goes along.
    onError: ({ error, path, ctx }) => {
      if (error.code !== "INTERNAL_SERVER_ERROR") return;
      void captureError(error.cause ?? error, {
        teamId: ctx?.teamId,
        tags: path ? { procedure: path } : {},
      });
    },
  });
};

export { handler as GET, handler as POST };
