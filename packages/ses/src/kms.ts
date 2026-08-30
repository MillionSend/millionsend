import { KMS } from "@aws-sdk/client-kms";
import { CompositeKeyring, EnvKeyring, type Keyring, KmsKeyring } from "@millionsend/core";

/** The env fields keyring selection reads (structural so tests pass literals). */
export interface KeyringEnv {
  IS_CLOUD: boolean;
  MASTER_ENCRYPTION_KEY?: string | undefined;
  KMS_KEY_ID?: string | undefined;
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID?: string | undefined;
  AWS_SECRET_ACCESS_KEY?: string | undefined;
}

/**
 * The one keyring construction shared by api/worker/smtp/web. Cloud wraps
 * new DEKs with KMS (credentials fall back to the default provider chain,
 * like the SES clients) behind the composite, so rows sealed under the env
 * KEK stay readable; self-host uses the env KEK alone.
 */
export function createKeyringFromEnv(e: KeyringEnv): Keyring {
  if (!e.MASTER_ENCRYPTION_KEY) throw new Error("MASTER_ENCRYPTION_KEY is required");
  const envKeyring = EnvKeyring.fromBase64(e.MASTER_ENCRYPTION_KEY);
  if (e.IS_CLOUD && e.KMS_KEY_ID) {
    const kms = new KmsKeyring(
      new KMS({
        region: e.AWS_REGION,
        ...(e.AWS_ACCESS_KEY_ID && e.AWS_SECRET_ACCESS_KEY
          ? {
              credentials: {
                accessKeyId: e.AWS_ACCESS_KEY_ID,
                secretAccessKey: e.AWS_SECRET_ACCESS_KEY,
              },
            }
          : {}),
      }),
      e.KMS_KEY_ID,
    );
    return new CompositeKeyring(kms, envKeyring);
  }
  return envKeyring;
}
