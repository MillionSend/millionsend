import { env } from "@millionsend/config";
import { getDb } from "@millionsend/db";
import { sql } from "drizzle-orm";
import { getAuth } from "@/server/auth";

// Lazy per-request lookup: module evaluation at build time must not
// construct auth (it requires runtime env).
const handler = async (req: Request): Promise<Response> => {
  const pathname = new URL(req.url).pathname;
  const mayCreateUser =
    pathname.endsWith("/api/auth/sign-up/email") || pathname.includes("/api/auth/callback/");
  if (
    !mayCreateUser ||
    env.ALLOW_SIGNUP === true ||
    process.env.ALLOW_SIGNUP === "true" ||
    process.env.ALLOW_SIGNUP === "1"
  ) {
    return getAuth().handler(req);
  }
  // The first-user gate in Better Auth's before-create hook is necessarily a
  // check followed by an insert. Serialize only the email-signup and social
  // callback routes that can create a user, across processes, so two
  // concurrent initial registrations cannot both see an empty user table.
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(7420385421937451::bigint)`);
    return getAuth().handler(req);
  });
};

export { handler as GET, handler as POST };
