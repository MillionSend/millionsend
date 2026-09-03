"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useRef, useState } from "react";
import { confirmDialog } from "@/components/confirm-dialog";
import { CopyChip } from "@/components/copy-chip";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { RelativeTime } from "@/components/relative-time";
import { Select } from "@/components/select";
import { Skeleton, SkeletonBadge } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { Table } from "@/components/table";
import { TeamLogo } from "@/components/team-logo";
import type { AppLocale } from "@/i18n/request";
import { authClient } from "@/lib/auth-client";
import { TEAM_LOGO_ACCEPT, TEAM_LOGO_MAX_BYTES } from "@/lib/image-type";
import { removeTeamLogo, uploadTeamLogo } from "@/lib/team-logo-api";
import { useTRPC } from "@/lib/trpc";
import { ListFooter } from "../emails/list-parts";

// Mirrors LOCALE_COOKIE in src/i18n/request.ts — that module reads
// next/headers and cannot be imported from client components.
const LOCALE_COOKIE = "NEXT_LOCALE";
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const LOCALE_OPTIONS: readonly AppLocale[] = ["en", "pt-BR"];

function SectionCard({
  title,
  action,
  children,
}: {
  title: string;
  /** Right-aligned control on the title row (the card's primary action). */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="ms-card" style={{ padding: 24 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          margin: "0 0 18px",
        }}
      >
        <h2
          className="ms-display"
          style={{ fontSize: "var(--ms-fs-h2)", color: "var(--ms-bone)", margin: 0 }}
        >
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function TeamSection({ billing }: { billing: boolean }) {
  const t = useTranslations("settings");
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: team } = useQuery(trpc.settings.team.get.queryOptions());
  const { data: teamList } = useQuery(trpc.team.list.queryOptions());
  const activeRole = teamList?.teams.find((m) => m.teamId === teamList.activeTeamId)?.role;
  const canManageLogo = activeRole === "owner" || activeRole === "admin";
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);

  async function runLogoChange(op: (teamId: string) => Promise<unknown>) {
    const teamId = teamList?.activeTeamId;
    if (!teamId || logoBusy) return;
    setLogoBusy(true);
    setLogoError(false);
    try {
      await op(teamId);
      await queryClient.invalidateQueries(trpc.settings.team.get.queryFilter());
      await queryClient.invalidateQueries(trpc.team.list.queryFilter());
      // Sidebar shows the logo from the server layout.
      router.refresh();
    } catch {
      setLogoError(true);
    } finally {
      setLogoBusy(false);
    }
  }
  const rename = useMutation(
    trpc.settings.team.rename.mutationOptions({
      onSuccess: async () => {
        setDraft(null);
        await queryClient.invalidateQueries(trpc.settings.team.get.queryFilter());
        // Sidebar shows the team name from the server layout.
        router.refresh();
      },
    }),
  );
  if (!team) {
    // Mirrors the loaded card with its real labels and wrappers — only the
    // values wait on data, so field spacing, the 30px input/button row and
    // the slug/plan line boxes match the loaded card exactly.
    return (
      <SectionCard title={t("team.title")}>
        <div className="ms-kpi-row" style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
          <div className="ms-field" style={{ flex: "1 1 220px", maxWidth: 280 }}>
            {/* span, not label: there is no control to label yet. Metrics mirror .ms-field label. */}
            <span
              style={{
                display: "block",
                fontSize: "var(--ms-fs-label)",
                color: "var(--ms-muted)",
                marginBottom: 6,
              }}
            >
              {t("team.name")}
            </span>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <Skeleton width={200} height={30} radius="var(--ms-r-input)" />
              <Skeleton width={56} height={30} radius="var(--ms-r-input)" />
            </div>
          </div>
          {billing ? (
            <div className="ms-field">
              <span
                style={{
                  display: "block",
                  fontSize: "var(--ms-fs-label)",
                  color: "var(--ms-muted)",
                  marginBottom: 6,
                }}
              >
                {t("team.plan")}
              </span>
              <div style={{ height: 30, display: "flex", alignItems: "center" }}>
                <SkeletonBadge width={48} />
              </div>
            </div>
          ) : null}
        </div>
      </SectionCard>
    );
  }

  const name = draft ?? team.name;
  return (
    <SectionCard title={t("team.title")}>
      {/* Name, logo and plan share one row; the row wraps into columns on narrow screens. */}
      <div className="ms-kpi-row" style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            rename.mutate({ name });
          }}
        >
          <div className="ms-field" style={{ flex: "1 1 220px", maxWidth: 280 }}>
            <label htmlFor="settings-team-name">{t("team.name")}</label>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <input
                id="settings-team-name"
                type="text"
                className="ms-input"
                style={{ flex: 1, maxWidth: 420 }}
                required
                maxLength={80}
                disabled={rename.isPending}
                value={name}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button type="submit" className="ms-btn ms-btn-secondary" disabled={rename.isPending}>
                <BtnSpinner on={rename.isPending} />
                {t("team.save")}
              </button>
              {rename.isSuccess && draft === null ? (
                <span style={{ color: "var(--ms-muted)", fontSize: "var(--ms-fs-label)" }}>
                  ✓ {t("team.saved")}
                </span>
              ) : null}
            </div>
          </div>
          {rename.isError ? (
            <p
              style={{
                margin: "8px 0 0",
                color: "var(--ms-danger)",
                fontSize: "var(--ms-fs-label)",
              }}
            >
              {t("team.error")}
            </p>
          ) : null}
        </form>
        {team.logoUploadsEnabled && canManageLogo ? (
          <div className="ms-field" style={{ maxWidth: 420 }}>
            {/* span, not label: the controls are buttons, not a labelable input. Metrics mirror .ms-field label. */}
            <span
              style={{
                display: "block",
                fontSize: "var(--ms-fs-label)",
                color: "var(--ms-muted)",
                marginBottom: 6,
              }}
            >
              {t("team.logo.label")}
            </span>
            <input
              ref={logoInputRef}
              type="file"
              accept={TEAM_LOGO_ACCEPT}
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Re-selecting the same file must fire change again.
                event.target.value = "";
                if (!file) return;
                if (file.size > TEAM_LOGO_MAX_BYTES) {
                  setLogoError(true);
                  return;
                }
                void runLogoChange((teamId) => uploadTeamLogo(teamId, file));
              }}
            />
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <TeamLogo name={team.name} logoUrl={team.logoUrl} size={30} />
              <button
                type="button"
                className="ms-btn ms-btn-secondary"
                disabled={logoBusy || !teamList}
                onClick={() => logoInputRef.current?.click()}
              >
                <BtnSpinner on={logoBusy} />
                {team.logoUrl ? t("team.logo.replace") : t("team.logo.upload")}
              </button>
              {team.logoUrl ? (
                <button
                  type="button"
                  className="ms-btn ms-btn-secondary"
                  disabled={logoBusy}
                  onClick={async () => {
                    const ok = await confirmDialog({
                      title: t("team.logo.removeTitle"),
                      message: t("team.logo.removeBody"),
                      confirmLabel: t("team.logo.remove"),
                      danger: true,
                    });
                    if (ok) void runLogoChange((teamId) => removeTeamLogo(teamId));
                  }}
                >
                  {t("team.logo.remove")}
                </button>
              ) : null}
            </div>
            <p
              style={{
                margin: "6px 0 0",
                color: "var(--ms-muted)",
                fontSize: "var(--ms-fs-label)",
              }}
            >
              {t("team.logo.hint")}
            </p>
            {logoError ? (
              <p
                style={{
                  margin: "6px 0 0",
                  color: "var(--ms-danger)",
                  fontSize: "var(--ms-fs-label)",
                }}
              >
                {t("team.logo.error")}
              </p>
            ) : null}
          </div>
        ) : null}
        {billing ? (
          <div className="ms-field">
            <span
              style={{
                display: "block",
                fontSize: "var(--ms-fs-label)",
                color: "var(--ms-muted)",
                marginBottom: 6,
              }}
            >
              {t("team.plan")}
            </span>
            <div style={{ height: 30, display: "flex", alignItems: "center" }}>
              {/* The pill is the way into billing; a paid plan reads as a success. */}
              <Link
                href="/settings/billing"
                className={`ms-badge ${team.plan === "free" ? "ms-badge-neutral" : "ms-badge-success"}`}
                style={{ textDecoration: "none" }}
              >
                {t(`plans.${team.plan}`)}
              </Link>
            </div>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}

function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("settings");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");

  const create = useMutation(
    trpc.settings.invitations.create.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries(trpc.settings.invitations.list.queryFilter()),
    }),
  );

  const { reset } = create;
  const close = useCallback(() => {
    onClose();
    setEmail("");
    setRole("member");
    reset();
  }, [onClose, reset]);

  // Shared by the form submit and the modal's ⌘↵ shortcut; in the created
  // state the primary action is just dismissing.
  const confirm = () => {
    if (create.data) {
      close();
      return;
    }
    if (email.trim().length === 0 || create.isPending) return;
    create.mutate({ email, role });
  };

  return (
    <Modal
      open={open}
      onClose={close}
      onConfirm={confirm}
      title={
        create.data
          ? t(create.data.emailed ? "invitations.created.sentTitle" : "invitations.created.title")
          : t("invitations.invite.title")
      }
    >
      {create.data ? (
        <form
          style={{ display: "grid", gap: 12, marginTop: 12 }}
          onSubmit={(event) => {
            event.preventDefault();
            close();
          }}
        >
          <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
            {t(
              create.data.emailed
                ? "invitations.created.emailedBody"
                : "invitations.created.bodyTtl",
              {
                email: create.data.email,
              },
            )}
          </p>
          <CopyChip value={create.data.acceptUrl} />
          {create.data.emailed ? null : (
            <p style={{ margin: 0, color: "var(--ms-warn)", fontSize: "var(--ms-fs-label)" }}>
              {t("invitations.created.noSender")}
            </p>
          )}
          <ModalFooter>
            <button type="submit" className="ms-btn ms-btn-primary">
              {t("invitations.created.done")} <ConfirmKeycap />
            </button>
          </ModalFooter>
        </form>
      ) : (
        <form
          style={{ display: "grid", gap: 14, marginTop: 12 }}
          onSubmit={(event) => {
            event.preventDefault();
            confirm();
          }}
        >
          <div className="ms-field">
            <label htmlFor="invite-email">{t("invitations.invite.email")}</label>
            <input
              id="invite-email"
              type="email"
              className="ms-input"
              style={{ width: "100%" }}
              required
              value={email}
              disabled={create.isPending}
              placeholder={t("invitations.invite.emailPlaceholder")}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="ms-field">
            <label htmlFor="invite-role">{t("invitations.invite.role")}</label>
            <Select
              id="invite-role"
              width="100%"
              value={role}
              disabled={create.isPending}
              onChange={(value) => setRole(value === "admin" ? "admin" : "member")}
              ariaLabel={t("invitations.invite.role")}
              options={[
                { value: "member", label: t("members.roles.member") },
                { value: "admin", label: t("members.roles.admin") },
              ]}
            />
          </div>
          {create.isError ? (
            <p style={{ margin: 0, color: "var(--ms-danger)", fontSize: "var(--ms-fs-label)" }}>
              {t("invitations.invite.error")}
            </p>
          ) : null}
          <ModalFooter>
            <button type="button" className="ms-btn ms-btn-secondary" onClick={close}>
              {common("cancel")} <span className="ms-keycap">Esc</span>
            </button>
            <button
              type="submit"
              className="ms-btn ms-btn-primary"
              disabled={email.trim().length === 0 || create.isPending}
            >
              <BtnSpinner on={create.isPending} />
              {t("invitations.invite.submit")} <ConfirmKeycap />
            </button>
          </ModalFooter>
        </form>
      )}
    </Modal>
  );
}

function PendingInvitations() {
  const t = useTranslations("settings");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data: invitations } = useQuery(trpc.settings.invitations.list.queryOptions());
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries(trpc.settings.invitations.list.queryFilter());
  const revoke = useMutation(
    trpc.settings.invitations.revoke.mutationOptions({ onSuccess: refresh }),
  );
  const resend = useMutation(
    trpc.settings.invitations.resend.mutationOptions({
      onSuccess: () => {
        setError(null);
        refresh();
      },
      onError: (e) => setError(e.message),
    }),
  );

  if (!invitations || invitations.length === 0) return null;
  const busy = revoke.isPending || resend.isPending;

  return (
    <div style={{ marginTop: 20 }}>
      <div className="ms-microlabel" style={{ marginBottom: 8 }}>
        {t("invitations.pending.title")}
      </div>
      <Table>
        <thead>
          <tr>
            <th>{t("invitations.pending.email")}</th>
            <th>{t("members.role")}</th>
            <th>{t("invitations.pending.expires")}</th>
            <th className="right" aria-label={t("invitations.pending.actions")} />
          </tr>
        </thead>
        <tbody>
          {invitations.map((invite) => (
            <tr key={invite.id}>
              <td className="ms-mono">{invite.email}</td>
              <td>{t(`members.roles.${invite.role}`)}</td>
              <td>
                {new Date(invite.expiresAt).getTime() <= Date.now() ? (
                  <span className="ms-badge ms-badge-warn">{t("invitations.pending.expired")}</span>
                ) : (
                  <RelativeTime date={invite.expiresAt} />
                )}
              </td>
              <td className="right" style={{ whiteSpace: "nowrap" }}>
                <button
                  type="button"
                  className="ms-btn ms-btn-secondary"
                  disabled={busy}
                  style={{ marginRight: 8 }}
                  onClick={() => resend.mutate({ id: invite.id })}
                >
                  {t("invitations.pending.resend")}
                </button>
                <button
                  type="button"
                  className="ms-btn ms-btn-secondary"
                  disabled={busy}
                  onClick={() => revoke.mutate({ id: invite.id })}
                >
                  {t("invitations.pending.revoke")}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {error ? (
        <p style={{ margin: "8px 0 0", color: "var(--ms-danger)", fontSize: "var(--ms-fs-label)" }}>
          {t("invitations.pending.resendError", { reason: error })}
        </p>
      ) : null}
      <ListFooter
        left={t("invitations.pending.pageOf", { pages: 1, total: invitations.length })}
        singlePage
      />
    </div>
  );
}

type MemberRole = "owner" | "admin" | "member";

function MembersSection() {
  const t = useTranslations("settings");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data: members } = useQuery(trpc.settings.members.list.queryOptions());
  const { data: teamList } = useQuery(trpc.team.list.queryOptions());
  const role = teamList?.teams.find((m) => m.teamId === teamList.activeTeamId)?.role;
  const canManage = role === "owner" || role === "admin";
  const [inviteOpen, setInviteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries(trpc.settings.members.list.queryFilter());
  const updateRole = useMutation(
    trpc.settings.members.updateRole.mutationOptions({
      onSuccess: refresh,
      onError: (e) => setError(e.message),
    }),
  );
  const remove = useMutation(
    trpc.settings.members.remove.mutationOptions({
      onSuccess: refresh,
      onError: (e) => setError(e.message),
    }),
  );
  const leave = useMutation(
    trpc.settings.members.leave.mutationOptions({
      // The selection cookie now points at a team the user left; a full
      // navigation lets the layout resolve the next membership (or onboarding).
      onSuccess: () => window.location.assign("/emails"),
      onError: (e) => setError(e.message),
    }),
  );
  const busy = updateRole.isPending || remove.isPending || leave.isPending;

  // The server refuses both; hiding the button avoids offering a dead end.
  const cannotLeave =
    !members ||
    members.length === 1 ||
    (role === "owner" && members.filter((m) => m.role === "owner").length === 1);

  // Admins never touch the owner role, in either direction.
  const roleOptions = (["owner", "admin", "member"] as const)
    .filter((r) => role === "owner" || r !== "owner")
    .map((r) => ({ value: r, label: t(`members.roles.${r}`) }));

  async function confirmRemove(member: { userId: string; email: string }) {
    const ok = await confirmDialog({
      title: t("members.removeTitle"),
      message: t("members.removeBody", { email: member.email }),
      confirmLabel: t("members.remove"),
      danger: true,
    });
    if (ok) remove.mutate({ userId: member.userId });
  }

  async function confirmLeave() {
    const ok = await confirmDialog({
      title: t("members.leaveTitle"),
      message: t("members.leaveBody"),
      confirmLabel: t("members.leave"),
      danger: true,
    });
    if (ok) leave.mutate();
  }

  return (
    <SectionCard
      title={t("members.title")}
      action={
        canManage ? (
          <button
            type="button"
            className="ms-btn ms-btn-primary"
            onClick={() => setInviteOpen(true)}
          >
            {t("invitations.invite.trigger")}
          </button>
        ) : null
      }
    >
      <Table>
        <thead>
          <tr>
            <th>{t("members.name")}</th>
            <th>{t("members.email")}</th>
            <th>{t("members.role")}</th>
            <th className="right" aria-label={t("members.actions")} />
          </tr>
        </thead>
        {!members ? (
          <tbody>
            <tr>
              <td>
                <Skeleton width={110} height={13} />
              </td>
              <td>
                <Skeleton width={180} height={13} />
              </td>
              <td>
                <Skeleton width={52} />
              </td>
              <td />
            </tr>
          </tbody>
        ) : (
          <tbody>
            {members.map((m) => {
              const editable = canManage && !m.self && (role === "owner" || m.role !== "owner");
              return (
                <tr key={m.userId}>
                  <td>{m.name}</td>
                  <td className="ms-mono">{m.email}</td>
                  <td>
                    {editable ? (
                      <Select
                        width={140}
                        value={m.role}
                        disabled={busy}
                        onChange={(value) =>
                          updateRole.mutate({ userId: m.userId, role: value as MemberRole })
                        }
                        ariaLabel={t("members.role")}
                        options={roleOptions}
                      />
                    ) : (
                      t(`members.roles.${m.role}`)
                    )}
                  </td>
                  <td className="right">
                    {m.self ? (
                      cannotLeave ? null : (
                        <button
                          type="button"
                          className="ms-btn ms-btn-secondary"
                          disabled={busy}
                          onClick={() => void confirmLeave()}
                        >
                          {t("members.leave")}
                        </button>
                      )
                    ) : editable ? (
                      <button
                        type="button"
                        className="ms-btn ms-btn-secondary"
                        disabled={busy}
                        onClick={() => void confirmRemove(m)}
                      >
                        {t("members.remove")}
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        )}
      </Table>
      {error ? (
        <p style={{ margin: "8px 0 0", color: "var(--ms-danger)", fontSize: "var(--ms-fs-label)" }}>
          {t("members.error", { reason: error })}
        </p>
      ) : null}
      {members ? (
        <ListFooter left={t("members.pageOf", { pages: 1, total: members.length })} singlePage />
      ) : null}
      {canManage ? <PendingInvitations /> : null}
      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} />
    </SectionCard>
  );
}

function LanguageSection() {
  const t = useTranslations("settings");
  const locale = useLocale();
  const router = useRouter();

  return (
    <SectionCard title={t("language.title")}>
      <div className="ms-field" style={{ flex: "1 1 220px", maxWidth: 280 }}>
        <label htmlFor="settings-locale">{t("language.label")}</label>
        <Select
          id="settings-locale"
          width={260}
          value={locale}
          onChange={(value) => {
            // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API is unavailable in Safari.
            document.cookie = `${LOCALE_COOKIE}=${value}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}`;
            router.refresh();
          }}
          ariaLabel={t("language.label")}
          options={LOCALE_OPTIONS.map((value) => ({ value, label: t(`language.${value}`) }))}
        />
      </div>
    </SectionCard>
  );
}

/** One numeric override field: empty = no override, hint shows the effective value. */
function InstanceField({
  id,
  label,
  min,
  max,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  min: number;
  max: number;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="ms-field" style={{ flex: "1 1 220px", maxWidth: 280 }}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        className="ms-input ms-number"
        style={{ width: "100%" }}
        min={min}
        max={max}
        step={1}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function InstanceSection() {
  const t = useTranslations("settings");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data } = useQuery(trpc.system.instanceSettings.get.queryOptions());
  const [rateDraft, setRateDraft] = useState<string | null>(null);
  const [retentionDraft, setRetentionDraft] = useState<string | null>(null);
  const save = useMutation(
    trpc.system.instanceSettings.update.mutationOptions({
      onSuccess: async () => {
        setRateDraft(null);
        setRetentionDraft(null);
        await queryClient.invalidateQueries(trpc.system.instanceSettings.get.queryFilter());
      },
    }),
  );
  if (!data) {
    // Mirrors the loaded card with its real subtitle wrapper and field
    // labels, so line boxes and the 30px inputs land where the data does.
    // The save-button row is omitted: canEdit is unknown until load.
    return (
      <SectionCard title={t("instance.title")}>
        <p style={{ margin: "-8px 0 16px", fontSize: "var(--ms-fs-label)", display: "flex" }}>
          <Skeleton width={260} height="1lh" />
        </p>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          {[t("instance.rateLabel"), t("instance.retentionLabel")].map((label) => (
            <div key={label} className="ms-field" style={{ flex: "1 1 220px", maxWidth: 280 }}>
              {/* span, not label: there is no control to label yet. Metrics mirror .ms-field label. */}
              <span
                style={{
                  display: "block",
                  fontSize: "var(--ms-fs-label)",
                  color: "var(--ms-muted)",
                  marginBottom: 6,
                }}
              >
                {label}
              </span>
              <Skeleton width="100%" height={30} radius="var(--ms-r-input)" />
            </div>
          ))}
        </div>
      </SectionCard>
    );
  }

  // Fields show the EFFECTIVE value (db, env, or default) — saving writes
  // what is shown, so what you see is always what runs.
  const rate = rateDraft ?? String(data.sesMaxSendRate.value);
  const retention = retentionDraft ?? String(data.emailRetentionDays.value);
  const clean = rateDraft === null && retentionDraft === null;

  return (
    <SectionCard title={t("instance.title")}>
      <p
        style={{
          margin: "-8px 0 16px",
          color: "var(--ms-muted)",
          fontSize: "var(--ms-fs-label)",
        }}
      >
        {t("instance.subtitle")}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({
            sesMaxSendRate: rate.trim() === "" ? null : Number(rate),
            emailRetentionDays: retention.trim() === "" ? null : Number(retention),
          });
        }}
      >
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <InstanceField
            id="settings-instance-rate"
            label={t("instance.rateLabel")}
            min={1}
            max={200}
            value={rate}
            disabled={!data.canEdit || save.isPending}
            onChange={setRateDraft}
          />
          <InstanceField
            id="settings-instance-retention"
            label={t("instance.retentionLabel")}
            min={1}
            max={3650}
            value={retention}
            disabled={!data.canEdit || save.isPending}
            onChange={setRetentionDraft}
          />
        </div>
        {data.canEdit ? (
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 16 }}>
            <button type="submit" className="ms-btn ms-btn-secondary" disabled={save.isPending}>
              <BtnSpinner on={save.isPending} />
              {t("instance.save")}
            </button>
            {save.isSuccess && clean ? (
              <span style={{ color: "var(--ms-muted)", fontSize: "var(--ms-fs-label)" }}>
                ✓ {t("instance.saved")}
              </span>
            ) : null}
          </div>
        ) : null}
        {save.isError ? (
          <p
            style={{ margin: "8px 0 0", color: "var(--ms-danger)", fontSize: "var(--ms-fs-label)" }}
          >
            {t("instance.error")}
          </p>
        ) : null}
      </form>
    </SectionCard>
  );
}

function DangerSection() {
  const t = useTranslations("settings.danger");
  const trpc = useTRPC();
  const { data: teamList } = useQuery(trpc.team.list.queryOptions());
  const active = teamList?.teams.find((m) => m.teamId === teamList.activeTeamId);
  const [error, setError] = useState<string | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);

  const deleteTeam = useMutation(
    trpc.settings.team.delete.mutationOptions({
      onSuccess: () => window.location.assign("/emails"),
      onError: (e) => setError(e.message),
    }),
  );

  async function confirmDeleteTeam() {
    if (!active) return;
    const ok = await confirmDialog({
      title: t("deleteTeam"),
      message: t("deleteTeamBody", { name: active.teamName }),
      confirmLabel: t("deleteTeam"),
      danger: true,
      typeToConfirm: true,
    });
    if (ok) deleteTeam.mutate();
  }

  async function confirmDeleteAccount() {
    const ok = await confirmDialog({
      title: t("deleteAccount"),
      message: t("deleteAccountBody"),
      confirmLabel: t("deleteAccount"),
      danger: true,
      typeToConfirm: true,
    });
    if (!ok) return;
    setAccountBusy(true);
    setError(null);
    // Server-side: sessions are revoked and a sole owner is refused.
    const result = await authClient.deleteUser();
    if (result.error) {
      setError(result.error.message ?? t("deleteAccountError"));
      setAccountBusy(false);
      return;
    }
    window.location.assign("/login");
  }

  const busy = deleteTeam.isPending || accountBusy;
  return (
    <SectionCard title={t("title")}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {active?.role === "owner" ? (
          <button
            type="button"
            className="ms-btn ms-btn-destructive"
            disabled={busy}
            onClick={() => void confirmDeleteTeam()}
          >
            <BtnSpinner on={deleteTeam.isPending} />
            {t("deleteTeam")}
          </button>
        ) : null}
        <button
          type="button"
          className="ms-btn ms-btn-destructive"
          disabled={busy}
          onClick={() => void confirmDeleteAccount()}
        >
          <BtnSpinner on={accountBusy} />
          {t("deleteAccount")}
        </button>
      </div>
      <p style={{ margin: "8px 0 0", color: "var(--ms-muted)", fontSize: "var(--ms-fs-label)" }}>
        {t("hint")}
      </p>
      {error ? (
        <p style={{ margin: "8px 0 0", color: "var(--ms-danger)", fontSize: "var(--ms-fs-label)" }}>
          {error}
        </p>
      ) : null}
    </SectionCard>
  );
}

export function SettingsSections({ showInstance }: { showInstance: boolean }) {
  return (
    <div style={{ display: "grid", gap: 20 }}>
      <TeamSection billing={!showInstance} />
      <MembersSection />
      {showInstance ? <InstanceSection /> : null}
      <LanguageSection />
      <DangerSection />
    </div>
  );
}
