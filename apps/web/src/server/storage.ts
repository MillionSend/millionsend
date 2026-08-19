import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "@millionsend/config";

/**
 * Optional S3-compatible object storage (team logo uploads). Enabled only
 * when all five STORAGE_S3_* variables are set — boot validation rejects
 * partial configuration, so here any missing value simply means "off".
 */
interface StorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Public base the bucket serves from, without a trailing slash. */
  publicUrl: string;
}

function storageConfig(): StorageConfig | null {
  const endpoint = env.STORAGE_S3_ENDPOINT;
  const bucket = env.STORAGE_S3_BUCKET;
  const accessKeyId = env.STORAGE_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.STORAGE_S3_SECRET_ACCESS_KEY;
  const publicUrl = env.STORAGE_S3_PUBLIC_URL;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey || !publicUrl) return null;
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    publicUrl: publicUrl.replace(/\/+$/, ""),
  };
}

/** Whether upload UI should render anywhere; the upload route 404s when false. */
export function uploadsEnabled(): boolean {
  return storageConfig() !== null;
}

function client(cfg: StorageConfig): S3Client {
  // Per call, not a singleton: uploads are rare enough that client reuse buys
  // nothing, and tests stub env per test. "auto" is R2's region; other
  // S3-compatibles generally accept any region for SigV4 against a custom
  // endpoint. forcePathStyle: R2 has no bucket-subdomain DNS.
  return new S3Client({
    endpoint: cfg.endpoint,
    region: "auto",
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
}

/** Uploads the object and returns its public URL (no cache-buster). */
export async function putPublicObject(
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<string> {
  const cfg = storageConfig();
  if (!cfg) throw new Error("storage is not configured");
  await client(cfg).send(
    new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: body, ContentType: contentType }),
  );
  return `${cfg.publicUrl}/${key}`;
}

/** Best-effort delete — storage cleanup must never fail the db-side operation. */
export async function deletePublicObject(key: string): Promise<void> {
  const cfg = storageConfig();
  if (!cfg) return;
  try {
    await client(cfg).send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
  } catch {
    // Orphaned objects are overwritten by the next upload of the same key.
  }
}

/**
 * Object key encoded in a stored public URL (path under STORAGE_S3_PUBLIC_URL,
 * cache-buster query stripped), or null for a URL outside the current bucket.
 */
export function keyFromPublicUrl(url: string): string | null {
  const cfg = storageConfig();
  if (!cfg || !url.startsWith(`${cfg.publicUrl}/`)) return null;
  return url.slice(cfg.publicUrl.length + 1).split("?")[0] || null;
}
