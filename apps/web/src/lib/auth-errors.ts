/**
 * Better Auth's captcha plugin refuses a request without a Turnstile token,
 * or with one Cloudflare rejected, with one of these codes.
 */
export function isCaptchaRefusal(code: string | undefined): boolean {
  return code === "VERIFICATION_FAILED" || code === "MISSING_RESPONSE";
}
