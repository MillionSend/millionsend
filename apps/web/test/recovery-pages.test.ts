import { afterEach, describe, expect, it, vi } from "vitest";
import ForgotPasswordPage from "@/app/forgot-password/page";
import ResetPasswordPage from "@/app/reset-password/page";
import { ForgotPasswordForm, ResetPasswordForm } from "@/components/auth/recovery-forms";
import { RESET_TOKEN_TTL_MINUTES } from "@/server/system-mail";

afterEach(() => {
  vi.unstubAllEnvs();
});

function stubRecoveryEnv(enabled: boolean) {
  vi.stubEnv("AUTH_EMAIL_FROM", enabled ? "MillionSend <no-reply@mail.example.com>" : "");
  vi.stubEnv("AWS_ACCESS_KEY_ID", enabled ? "test-key" : "");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", enabled ? "test-secret" : "");
  vi.stubEnv("AWS_DEFAULT_CHAIN", "");
}

describe("ForgotPasswordPage", () => {
  const params = (query: Record<string, string | string[]> = {}) => ({
    searchParams: Promise.resolve(query),
  });

  it("redirects to /login when recovery is disabled", async () => {
    stubRecoveryEnv(false);
    let digest = "";
    try {
      await ForgotPasswordPage(params());
    } catch (error) {
      digest = (error as { digest?: string }).digest ?? "";
    }
    expect(digest).toContain("NEXT_REDIRECT");
    expect(digest).toContain("/login");
  });

  it("renders the form with the token TTL when recovery is enabled", async () => {
    stubRecoveryEnv(true);
    const page = await ForgotPasswordPage(params());
    expect(page.type).toBe(ForgotPasswordForm);
    expect(page.props.minutes).toBe(RESET_TOKEN_TTL_MINUTES);
    expect(page.props.initialEmail).toBe("");
  });

  it("seeds the email from the login link's query, trimmed and capped", async () => {
    stubRecoveryEnv(true);
    const seeded = await ForgotPasswordPage(params({ email: "  ada@example.com " }));
    expect(seeded.props.initialEmail).toBe("ada@example.com");
    const long = await ForgotPasswordPage(params({ email: "a".repeat(300) }));
    expect(long.props.initialEmail).toHaveLength(254);
    const arr = await ForgotPasswordPage(params({ email: ["x@y.z", "w@y.z"] }));
    expect(arr.props.initialEmail).toBe("");
  });
});

describe("ResetPasswordPage", () => {
  it("passes the token from the query through", async () => {
    const page = await ResetPasswordPage({ searchParams: Promise.resolve({ token: "tok123" }) });
    expect(page.type).toBe(ResetPasswordForm);
    expect(page.props.token).toBe("tok123");
  });

  it("collapses better-auth's ?error= redirect and a missing token to null", async () => {
    const withError = await ResetPasswordPage({
      searchParams: Promise.resolve({ error: "INVALID_TOKEN", token: "tok123" }),
    });
    expect(withError.props.token).toBeNull();
    const bare = await ResetPasswordPage({ searchParams: Promise.resolve({}) });
    expect(bare.props.token).toBeNull();
  });
});
