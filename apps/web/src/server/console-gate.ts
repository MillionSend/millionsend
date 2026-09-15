import type { Db } from "@millionsend/db";
import { getDb } from "@millionsend/db";
import { getAuth } from "./auth";
import { isInstanceOperator } from "./instance-operator";

export interface ConsoleGateDeps {
  session(headers: Headers): Promise<{ user: { id: string; email: string; name: string } } | null>;
  db(): Db;
}

const defaultDeps: ConsoleGateDeps = {
  session: (headers) => getAuth().api.getSession({ headers }),
  db: getDb,
};

/**
 * The console's gate, shared by its layout and the pages under it: the
 * signed-in user when they are the instance operator, null for everyone
 * else — signed out or signed in alike, so a member learns nothing more
 * than a stranger. Callers answer null with notFound().
 */
export async function consoleOperator(
  headers: Headers,
  deps: ConsoleGateDeps = defaultDeps,
): Promise<{ id: string; email: string; name: string } | null> {
  const session = await deps.session(headers);
  if (!session) return null;
  return (await isInstanceOperator(deps.db(), session.user.id)) ? session.user : null;
}
