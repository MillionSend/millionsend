"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AuthShell } from "@/components/auth-shell";
import { BtnSpinner } from "@/components/spinner";
import { authClient } from "@/lib/auth-client";
import { useTRPC } from "@/lib/trpc";

export default function AcceptInvitePage() {
  const t = useTranslations("settings");
  const params = useParams<{ token: string }>();
  const token = params.token;
  const router = useRouter();
  const trpc = useTRPC();
  const { data: session, isPending } = authClient.useSession();

  const accept = useMutation(
    trpc.settings.invitations.accept.mutationOptions({
      onSuccess: () => router.push("/emails"),
    }),
  );

  // The signed-out visitor routes through sign-in/up and back to this page.
  const next = `/invite/${encodeURIComponent(token)}`;

  return (
    <AuthShell>
      <div style={{ display: "grid", gap: 16 }}>
        <h1 className="ms-display" style={{ fontSize: "var(--ms-fs-h2)", margin: 0 }}>
          {t("invitations.accept.title")}
        </h1>
        {isPending ? (
          <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
            {t("invitations.accept.loading")}
          </p>
        ) : !session ? (
          <>
            <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
              {t("invitations.accept.signInPrompt")}
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <Link
                className="ms-btn ms-btn-primary"
                href={`/login?next=${encodeURIComponent(next)}`}
              >
                {t("invitations.accept.signIn")}
              </Link>
              <Link
                className="ms-btn ms-btn-secondary"
                href={`/signup?next=${encodeURIComponent(next)}`}
              >
                {t("invitations.accept.signUp")}
              </Link>
            </div>
          </>
        ) : accept.isError ? (
          <p style={{ margin: 0, color: "var(--ms-danger)", fontSize: "var(--ms-fs-ui)" }}>
            {t("invitations.accept.invalid")}
          </p>
        ) : (
          <>
            <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
              {t("invitations.accept.body", { email: session.user.email })}
            </p>
            <button
              type="button"
              className="ms-btn ms-btn-primary"
              disabled={accept.isPending}
              onClick={() => accept.mutate({ token })}
            >
              <BtnSpinner on={accept.isPending} />
              {t("invitations.accept.submit")}
            </button>
          </>
        )}
      </div>
    </AuthShell>
  );
}
