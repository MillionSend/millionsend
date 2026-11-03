import { getAuth } from "@/server/auth";
import { withStandardRetryAfter } from "@/server/retry-after";

// RFC 8414: OAuth clients resolve the issuer's metadata at the site root.
// The provider plugin answers this path itself when handed the raw request.
export const GET = async (req: Request): Promise<Response> =>
  withStandardRetryAfter(await getAuth().handler(req));
