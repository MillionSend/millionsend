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
  it("redirects to /login when recovery is disabled", () => {
    stubRecoveryEnv(false);
    let digest = "";
    try {
      ForgotPasswordPage();
    } catch (error) {
      digest = (error as { digest?: string }).digest ?? "";
    }
    expect(digest).toContain("NEXT_REDIRECT");
    expect(digest).toContain("/login");
  });

  it("renders the form with the token TTL when recovery is enabled", () => {
    stubRecoveryEnv(true);
    const page = ForgotPasswordPage();
    expect(page.type).toBe(ForgotPasswordForm);
    expect(page.props.minutes).toBe(RESET_TOKEN_TTL_MINUTES);
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
