import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { createApi } from "@millionsend/api";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";

export interface LiveApi {
  /** http://127.0.0.1:<ephemeral port> */
  baseUrl: string;
  /** Full-access key of the seeded team. */
  apiKey: string;
  teamId: string;
  db: Db;
  stop(): Promise<void>;
}

export async function createApiKey(
  db: Db,
  teamId: string,
  permission: "full_access" | "sending_access" = "full_access",
): Promise<string> {
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: permission,
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
    permission,
  });
  return key.token;
}

/**
 * The real API (PGlite, fake SES answering every identity call with {}) on a
 * local port, with one team and one full-access key.
 */
export async function startLiveApi(
  options: { isCloud?: boolean; appBaseUrl?: string | undefined; slug?: string } = {},
): Promise<LiveApi> {
  const { db, close } = await createTestDb();
  const teamId = await createTeam(db, options.slug ?? "migrate");
  const apiKey = await createApiKey(db, teamId);
  const app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: options.isCloud ?? true,
    enqueueEmailSend: async () => {},
    appBaseUrl: options.appBaseUrl,
    ses: {
      clientForRegion: () => ({ send: async () => ({}) }),
      dns: {
        resolveTxt: async () => [],
        resolveMx: async () => [],
        resolveCname: async () => [],
      },
      defaultRegion: "us-east-1",
    },
  });
  let server: ReturnType<typeof serve> | undefined;
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) =>
      resolve(info.port),
    );
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey,
    teamId,
    db,
    stop: async () => {
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      await close();
    },
  };
}
