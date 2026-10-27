/**
 * Better Auth's captcha plugin refuses a request without a Turnstile token,
 * or with one Cloudflare rejected, with one of these codes.
 */
export function isCaptchaRefusal(code: string | undefined): boolean {
  return code === "VERIFICATION_FAILED" || code === "MISSING_RESPONSE";
}

/**
 * A sign-up refused because its network opened its day's accounts; the
 * social callback hands it back to the form as ?error=.
 */
export const SIGNUP_LIMIT_CODE = "SIGNUP_IP_LIMIT";
