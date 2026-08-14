"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { AuthShell } from "@/components/auth-shell";
import { authClient } from "@/lib/auth-client";

export default function LoginPage() {
  const t = useTranslations("auth.login");
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setFailed(false);
    const { error } = await authClient.signIn.email({ email, password });
    if (error) {
      setFailed(true);
      setPending(false);
      return;
    }
    // The dashboard layout guard bounces team-less users to /onboarding.
    router.push("/emails");
  }

  return (
    <AuthShell>
      <form onSubmit={onSubmit} style={{ display: "grid", gap: 16 }}>
        <h1 className="ms-display" style={{ fontSize: "var(--ms-fs-h2)", margin: 0 }}>
          {t("title")}
        </h1>
        <div className="ms-field">
          <label htmlFor="email">{t("email")}</label>
          <input
            id="email"
            type="email"
            className="ms-input"
            style={{ width: "100%" }}
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="ms-field">
          <label htmlFor="password">{t("password")}</label>
          <input
            id="password"
            type="password"
            className="ms-input"
            style={{ width: "100%" }}
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {failed ? (
          <p style={{ margin: 0, color: "var(--ms-danger)", fontSize: "var(--ms-fs-label)" }}>
            {t("error")}
          </p>
        ) : null}
        <button type="submit" className="ms-btn ms-btn-primary" disabled={pending}>
          {t("submit")}
        </button>
        <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-label)" }}>
          {t("noAccount")} <Link href="/signup">{t("signupLink")}</Link>
        </p>
      </form>
    </AuthShell>
  );
}
