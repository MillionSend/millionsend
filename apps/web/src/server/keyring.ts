import { env } from "@millionsend/config";
import type { Keyring } from "@millionsend/core";
import { createKeyringFromEnv } from "@millionsend/ses";
import { TRPCError } from "@trpc/server";

// Built lazily so the web process only demands encryption configuration when
// a sealed value is actually read or written, and so tests can point the env
// at a test key first.
let keyring: Keyring | undefined;

export function getKeyring(): Keyring {
  if (!keyring) {
    try {
      keyring = createKeyringFromEnv(env);
    } catch (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err instanceof Error ? err.message : "encryption is not configured",
      });
    }
  }
  return keyring;
}
