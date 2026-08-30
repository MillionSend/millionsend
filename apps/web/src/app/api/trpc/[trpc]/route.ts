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
  });
};

export { handler as GET, handler as POST };
