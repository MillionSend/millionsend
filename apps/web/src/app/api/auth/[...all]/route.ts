import { getAuth } from "@/server/auth";

// Lazy per-request lookup: module evaluation at build time must not
// construct auth (it requires runtime env).
const handler = (req: Request) => getAuth().handler(req);

export { handler as GET, handler as POST };
