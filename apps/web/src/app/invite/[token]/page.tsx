"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AuthShell } from "@/components/auth-shell";
import { BtnSpinner } from "@/components/spinner";
import { authClient } from "@/lib/auth-client";
import { useTRPC } from "@/lib/trpc";

const muted = { margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" } as const;

export default function AcceptInvitePage() {
  const t = useTranslations("settings");
  const params = useParams<{ token: string }>();
  const token = params.token;
  const router = useRouter();
  const trpc = useTRPC();
  const { data: session, isPending } = authClient.useSession();
  // The signed token is the credential, so the preview needs no session.
  const preview = useQuery(trpc.settings.invitations.preview.queryOptions({ token }));

  const accept = useMutation(
    trpc.settings.invitations.accept.mutationOptions({
      onSuccess: () => router.push("/emails"),
    }),
  );

  // The signed-out visitor routes through sign-in/up and back to this page.
  const next = `/invite/${encodeURIComponent(token)}`;
  const invite = preview.data;
  const role = invite ? t(`members.roles.${invite.role}`) : "";

  return (
    <AuthShell>
      <div style={{ display: "grid", gap: 16 }}>
        <h1 className="ms-display" style={{ fontSize: "var(--ms-fs-h2)", margin: 0 }}>
          {t("invitations.accept.title")}
        </h1>
        {invite ? (
          <p style={{ ...muted, color: "var(--ms-bone)" }}>
            {invite.inviterName
              ? t("invitations.accept.invitedBy", {
                  inviter: invite.inviterName,
                  team: invite.teamName,
                  role,
                })
              : t("invitations.accept.invitedByUnknown", { team: invite.teamName, role })}
          </p>
        ) : null}
        {preview.isError || invite?.state === "expired" || invite?.state === "accepted" ? (
          <p style={{ ...muted, color: "var(--ms-danger)" }}>
            {invite?.state === "expired"
              ? t("invitations.accept.expired")
              : invite?.state === "accepted"
                ? t("invitations.accept.accepted")
                : t("invitations.accept.invalid")}
          </p>
        ) : isPending || preview.isPending ? (
          <p style={muted}>{t("invitations.accept.loading")}</p>
        ) : !session ? (
          <>
            <p style={muted}>{t("invitations.accept.signInPrompt")}</p>
            {invite ? (
              <p style={muted}>{t("invitations.accept.forEmail", { email: invite.email })}</p>
            ) : null}
            <div style={{ display: "flex", gap: 10 }}>
              <Link
                className="ms-btn ms-btn-primary"
                href={`/login?next=${encodeURIComponent(next)}`}
              >
                {t("invitations.accept.signIn")}
              </Link>
              <Link
                className="ms-btn ms-btn-secondary"
                href={`/signup?next=${encodeURIComponent(next)}${
                  invite?.prefillEmail ? `&email=${encodeURIComponent(invite.prefillEmail)}` : ""
                }`}
              >
                {t("invitations.accept.signUp")}
              </Link>
            </div>
          </>
        ) : accept.isError ? (
          <p style={{ ...muted, color: "var(--ms-danger)" }}>
            {accept.error.data?.code === "FORBIDDEN"
              ? t("invitations.accept.emailMismatch")
              : t("invitations.accept.invalid")}
          </p>
        ) : (
          <>
            <p style={muted}>{t("invitations.accept.body", { email: session.user.email })}</p>
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
