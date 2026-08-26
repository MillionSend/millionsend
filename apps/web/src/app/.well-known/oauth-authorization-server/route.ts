import { getAuth } from "@/server/auth";

// RFC 8414: OAuth clients resolve the issuer's metadata at the site root.
// The provider plugin answers this path itself when handed the raw request.
export const GET = (req: Request): Promise<Response> => getAuth().handler(req);
