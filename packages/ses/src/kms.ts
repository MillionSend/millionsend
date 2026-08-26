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
 * DEKs with KMS (credentials fall back to the default provider chain, like
 * the SES clients); cloud with the env KEK also set gets the composite so
 * ciphertexts sealed before a self-host → cloud migration stay readable;
 * everything else uses the env KEK.
 */
export function createKeyringFromEnv(e: KeyringEnv): Keyring {
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
    return e.MASTER_ENCRYPTION_KEY
      ? new CompositeKeyring(kms, EnvKeyring.fromBase64(e.MASTER_ENCRYPTION_KEY))
      : kms;
  }
  if (!e.MASTER_ENCRYPTION_KEY) {
    throw new Error("MASTER_ENCRYPTION_KEY is required (IS_CLOUD=true may use KMS_KEY_ID instead)");
  }
  return EnvKeyring.fromBase64(e.MASTER_ENCRYPTION_KEY);
}
