/**
 * Detects AWS credential failures surfaced through an error message, so forms
 * can map them to a catalog line instead of raw SDK text. Names per AWS SDK
 * v3: UnrecognizedClientException (bad key id), InvalidClientTokenId,
 * SignatureDoesNotMatch (bad secret), plus the default provider chain's
 * "Could not load credentials" and STS "security token" phrasing.
 */
const CREDENTIAL_ERROR_RE =
  /credential|security token|UnrecognizedClient|InvalidClientTokenId|SignatureDoesNotMatch|InvalidSignature/i;

export function isAwsCredentialError(message: string): boolean {
  return CREDENTIAL_ERROR_RE.test(message);
}
