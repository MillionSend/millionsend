"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { Breakable } from "@/components/breakable";
import { confirmDialog } from "@/components/confirm-dialog";
import { CopyChip } from "@/components/copy-chip";
import { EmailContentPanel } from "@/components/email-content-panel";
import { LoadError } from "@/components/load-error";
import { MetaItem } from "@/components/meta-item";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { PopoverMenu } from "@/components/popover-menu";
import { Select } from "@/components/select";
import { Skeleton, SkeletonBadge, SkeletonChip } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { Table } from "@/components/table";
import { toast } from "@/components/toast";
import { AUTH_CHECKS, dkimSignerDomains, grayExplanation } from "@/lib/auth-result";
import { formatBytes, formatDayTime, formatRelative, mailDomain } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";
import { useTeamRole } from "@/lib/use-team-role";
import { QuarantinedBadge, TrustBadge } from "../../parts";
import { AuthBadge } from "../received-list";

const LIST_HREF = "/inboxes/received";

const META_GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, 1fr)",
  gap: "22px 28px",
  padding: "22px 0",
  borderTop: "1px solid var(--ms-line)",
  borderBottom: "1px solid var(--ms-line)",
};

const note: React.CSSProperties = { fontSize: 12, color: "var(--ms-muted)", lineHeight: 1.5 };

/** A meta value that is data: mono, breaking between an address's parts. */
function Mono({ text }: { text: string }) {
  return (
    <span className="ms-mono" style={{ fontSize: 13, overflowWrap: "anywhere" }}>
      <Breakable text={text} />
    </span>
  );
}

function Banner({ tone, children }: { tone: "danger" | "warn"; children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="ms-wrap-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        fontSize: 13.5,
        border: `1px solid var(--ms-${tone}-border)`,
        color: `var(--ms-${tone})`,
        borderRadius: 12,
        padding: "11px 16px",
        marginBottom: 18,
      }}
    >
      {children}
    </div>
  );
}

/** Mirrors the loaded page's boxes (header, meta grid, content panel). */
function ReceivedEmailSkeleton() {
  const t = useTranslations("emails");
  const ti = useTranslations("inboxes");
  return (
    <>
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", fontSize: 13, lineHeight: 1, marginBottom: 10 }}>
          <Skeleton width={150} height="1lh" />
        </div>
        <h1
          className="ms-display"
          style={{ fontSize: "var(--ms-fs-h1)", margin: 0, display: "flex" }}
        >
          <Skeleton width={260} height="1lh" />
        </h1>
        <div className="ms-mono" style={{ fontSize: 12, marginTop: 8, display: "flex" }}>
          <Skeleton width={180} height="1lh" />
        </div>
      </div>
      <div className="ms-meta-grid" style={META_GRID}>
        <MetaItem label={t("detail.subject")}>
          <Skeleton width={200} height={14} />
        </MetaItem>
        <MetaItem label={t("detail.id")}>
          <SkeletonChip width={190} />
        </MetaItem>
        <MetaItem label={ti("detail.auth")}>
          <SkeletonBadge width={70} />
          <SkeletonBadge width={76} />
          <SkeletonBadge width={84} />
        </MetaItem>
      </div>
      <div
        style={{
          marginTop: 26,
          height: 640,
          border: "1px solid var(--ms-line)",
          borderRadius: 14,
          background: "var(--ms-panel)",
        }}
      />
    </>
  );
}

export function ReceivedEmailView() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations("inboxes");
  const te = useTranslations("emails");
  const common = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const role = useTeamRole();
  const query = useQuery(
    trpc.receiving.get.queryOptions(
      { id },
      // Each read parses the raw message again (up to 40 MiB), so a refocus
      // reuses it for a while; the download links are signed for an hour, and
      // a page left open re-signs them well before they lapse.
      { retry: false, staleTime: 10 * 60_000, refetchInterval: 30 * 60_000 },
    ),
  );
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: trpc.receiving.get.queryKey({ id }) });
  const releaseInbox = useMutation(
    trpc.inboxes.quarantine.release.mutationOptions({ onSuccess: refresh }),
  );
  const releaseRow = useMutation(trpc.receiving.release.mutationOptions({ onSuccess: refresh }));
  const remove = useMutation(
    trpc.receiving.delete.mutationOptions({
      onSuccess: () => {
        // Dropped, not invalidated: a stale list would paint the deleted email until its refetch landed.
        queryClient.removeQueries(trpc.receiving.list.pathFilter());
        router.push(LIST_HREF);
      },
      onError: () => toast(t("detail.deleteError"), "danger"),
    }),
  );
  const [composer, setComposer] = useState<"reply" | "forward" | null>(null);
  const closeComposer = useCallback(() => setComposer(null), []);
  const email = query.data;

  if (query.isPending) return <ReceivedEmailSkeleton />;
  if (query.isError || !email) {
    return (
      <LoadError
        error={query.error}
        headline={t("detail.error")}
        notFoundHeadline={t("detail.notFound")}
        onRetry={() => query.refetch()}
        backHref={LIST_HREF}
        backLabel={t("received.title")}
      />
    );
  }

  const { envelope } = email;
  const virus = email.virus.verdict === "fail";
  const held = email.memberships.find((m) => m.verdict === "quarantined");
  const pending = email.memberships.some((m) => m.verdict === "pending");
  const canRelease = Boolean(held) || email.heldCatchAll;
  const subtitle = [
    formatRelative(email.createdAt, locale),
    formatBytes(email.sizeBytes),
    ...(email.attachmentCount > 0
      ? [t("detail.attachmentCount", { count: email.attachmentCount })]
      : []),
    envelope.tls?.protocol ?? t("detail.noTls"),
  ].join(" · ");
  const signers = dkimSignerDomains(
    email.headers?.["dkim-signature"] ?? "",
    mailDomain(email.from),
  );
  const release = (trustSender: boolean) => {
    if (held) {
      releaseInbox.mutate({ inboxId: held.inboxId, emailId: email.id, trustSender });
    } else if (email.heldCatchAll) {
      releaseRow.mutate({ id: email.id });
    }
  };
  const releasing = releaseInbox.isPending || releaseRow.isPending;

  // received → scanned → screened → delivered / quarantined / released →
  // replied / forwarded → webhook, each with what is known of it.
  const timeline: { key: string; label: string; detail?: string; at?: Date | string }[] = [
    { key: "received", label: t("timeline.received"), at: email.createdAt },
    ...(email.virus.verdict || email.spam.verdict
      ? [
          {
            key: "scanned",
            label: t("timeline.scanned"),
            detail: [
              ...(email.spam.verdict ? [t(`spam.${email.spam.verdict}`)] : []),
              email.virus.verdict === "fail"
                ? t("virus.fail", { signature: email.virus.signature ?? "" })
                : t(`virus.${email.virus.verdict ?? "none"}`),
            ].join(" · "),
          },
        ]
      : []),
    ...email.memberships.flatMap((m) => [
      ...(m.injectionScore !== null || m.phishingScore !== null
        ? [
            {
              key: `screened-${m.inboxId}`,
              label: t("timeline.screened"),
              detail: t("detail.scores", {
                injection: m.injectionScore ?? "–",
                phishing: m.phishingScore ?? "–",
              }),
            },
          ]
        : []),
      ...(m.quarantinedAt
        ? [
            {
              key: `quarantined-${m.inboxId}`,
              label: t("timeline.quarantined"),
              detail: m.quarantineReason ? t(`qr.${m.quarantineReason}`) : m.address,
              at: m.quarantinedAt,
            },
          ]
        : []),
      ...(m.releasedAt
        ? [
            {
              key: `released-${m.inboxId}`,
              label: t("timeline.released", { who: m.releasedByName ?? "—" }),
              at: m.releasedAt,
            },
          ]
        : []),
      ...(m.deliveredAt
        ? [
            {
              key: `delivered-${m.inboxId}`,
              label: t("timeline.delivered", { inbox: m.address }),
              at: m.deliveredAt,
            },
          ]
        : []),
    ]),
    ...email.activity
      .filter((a) => a.action !== "email.released")
      .map((a, index) => ({
        key: `activity-${index}`,
        label: a.action === "email.forwarded" ? t("timeline.forwarded") : t("timeline.replied"),
        ...(a.by ? { detail: a.by } : {}),
        at: a.at,
      })),
    ...(email.webhook
      ? [
          {
            key: "webhook",
            label: t("timeline.webhook"),
            detail: `email.received · ${email.webhook.responseCode ?? email.webhook.status}`,
            at: email.webhook.at,
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        breadcrumb={
          <>
            <Crumb href={LIST_HREF} label={t("received.title")} />
            <CrumbEnd label={t("detail.breadcrumb")} />
          </>
        }
        title={email.fromName || email.from || email.subject || t("noSubject")}
        subtitle={subtitle}
        actions={
          <>
            {canRelease ? (
              <button
                type="button"
                className="ms-btn ms-btn-primary"
                disabled={releasing}
                onClick={() => release(false)}
              >
                <BtnSpinner on={releasing} />
                {t("release")}
              </button>
            ) : null}
            <button
              type="button"
              className="ms-btn ms-btn-secondary"
              onClick={() => setComposer("reply")}
            >
              {t("detail.reply")}
            </button>
            {virus ? null : (
              <button
                type="button"
                className="ms-btn ms-btn-secondary"
                onClick={() => setComposer("forward")}
              >
                {t("detail.forward")}
              </button>
            )}
            {email.rawUrl ? (
              <a className="ms-btn ms-btn-secondary" href={email.rawUrl}>
                {t("detail.downloadRaw")}
              </a>
            ) : null}
          </>
        }
        menu={
          role === "owner" || role === "admin" ? (
            <PopoverMenu
              boxed
              ariaLabel={t("detail.more")}
              items={[
                {
                  label: t("detail.deleteNow"),
                  danger: true,
                  onSelect: async () => {
                    const ok = await confirmDialog({
                      title: t("detail.deleteNow"),
                      message: t("detail.deleteConfirm"),
                      confirmLabel: t("detail.deleteNow"),
                      danger: true,
                    });
                    if (ok) remove.mutate({ id: email.id });
                  },
                },
              ]}
            />
          ) : undefined
        }
      />

      {virus ? (
        <Banner tone="danger">
          {t("downloadsBlocked")}
          {email.virus.signature ? (
            <span className="ms-mono" style={{ color: "var(--ms-bone)" }}>
              {email.virus.signature}
            </span>
          ) : null}
        </Banner>
      ) : null}
      {held || email.heldCatchAll ? (
        <Banner tone="danger">
          <span style={{ flex: "1 1 18rem" }}>{t("message.quarantined")}</span>
          {held ? (
            <button
              type="button"
              className="ms-btn ms-btn-secondary"
              disabled={releasing}
              onClick={() => release(true)}
            >
              {t("releaseTrust")}
            </button>
          ) : null}
        </Banner>
      ) : pending ? (
        <Banner tone="warn">{t("message.screening")}</Banner>
      ) : null}

      <div className="ms-meta-grid" style={META_GRID}>
        <MetaItem label={te("detail.from")}>
          <Mono text={email.fromName ? `${email.fromName} <${email.from}>` : email.from || "<>"} />
        </MetaItem>
        <MetaItem label={te("detail.subject")}>
          {email.subject || <span style={{ color: "var(--ms-muted)" }}>{t("noSubject")}</span>}
        </MetaItem>
        <MetaItem label={te("detail.id")}>
          <CopyChip value={email.id} />
        </MetaItem>
        {email.to.length > 0 ? (
          <MetaItem label={te("detail.to")}>
            <Mono text={email.to.join(", ")} />
          </MetaItem>
        ) : null}
        <MetaItem label={t("detail.receivedFor")}>
          <Mono text={email.receivedFor.join(", ")} />
        </MetaItem>
        <MetaItem label={t("detail.inboxes")}>
          {email.memberships.length === 0 ? (
            <span style={{ color: "var(--ms-muted)" }}>{t("detail.catchAllOnly")}</span>
          ) : (
            <span style={{ display: "grid", gap: 4 }}>
              {email.memberships.map((m) => (
                <span
                  key={m.inboxId}
                  style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}
                >
                  <Link
                    className="ms-link ms-mono"
                    href={`/inboxes/${m.inboxId}?thread=${m.threadId}`}
                  >
                    {m.address}
                  </Link>
                  {m.verdict === "quarantined" ? (
                    <QuarantinedBadge reason={m.quarantineReason} />
                  ) : null}
                </span>
              ))}
            </span>
          )}
        </MetaItem>
        {email.cc.length > 0 ? (
          <MetaItem label={te("detail.cc")}>
            <Mono text={email.cc.join(", ")} />
          </MetaItem>
        ) : null}
        {email.replyTo.length > 0 ? (
          <MetaItem label={te("detail.replyTo")}>
            <Mono text={email.replyTo.join(", ")} />
          </MetaItem>
        ) : null}
        <MetaItem label={t("detail.auth")}>
          <span style={{ display: "grid", gap: 6 }}>
            {AUTH_CHECKS.map((check) => {
              const result = email.authentication[check];
              const gray = grayExplanation(check, result, email.authDetail);
              return (
                <span key={check} style={{ display: "grid", gap: 2 }}>
                  <span>
                    <AuthBadge check={check} result={result} />
                  </span>
                  {gray ? (
                    <span style={note}>
                      {t(`gray.${gray}`, {
                        domains: signers.length > 0 ? signers.join(", ") : t("gray.anotherDomain"),
                      })}
                    </span>
                  ) : null}
                </span>
              );
            })}
          </span>
        </MetaItem>
        <MetaItem label={t("detail.trust")}>
          <TrustBadge trust={email.senderTrust} />
        </MetaItem>
        <MetaItem label={t("detail.spam")}>
          {email.spam.verdict ? (
            <span>
              {t(`spam.${email.spam.verdict}`)}
              {email.spam.score !== null ? (
                <span className="ms-mono" style={{ color: "var(--ms-muted)", marginLeft: 6 }}>
                  {email.spam.score}
                </span>
              ) : null}
            </span>
          ) : (
            <span style={{ color: "var(--ms-muted)" }}>{t("virus.none")}</span>
          )}
        </MetaItem>
        <MetaItem label={t("detail.virus")}>
          <span style={{ color: virus ? "var(--ms-danger)" : undefined }}>
            {virus
              ? t("virus.fail", { signature: email.virus.signature ?? "" })
              : t(`virus.${email.virus.verdict ?? "none"}`)}
          </span>
        </MetaItem>
        {email.hiddenTextRemoved ? (
          <MetaItem label={t("detail.hiddenText")}>
            <span className="ms-badge ms-badge-warn">{t("message.hiddenText")}</span>
          </MetaItem>
        ) : null}
        {email.extracted?.code ? (
          <MetaItem label={t("detail.code")}>
            <CopyChip value={email.extracted.code} />
          </MetaItem>
        ) : null}
        {email.extracted?.link ? (
          <MetaItem label={t("detail.link")}>
            <CopyChip value={email.extracted.link.url} />
            {email.extracted.link.matchesSender ? null : (
              <span style={note}>{t("detail.linkElsewhere")}</span>
            )}
          </MetaItem>
        ) : null}
        <MetaItem label={t("detail.envelopeFrom")}>
          {/* The null sender <> is how bounces and auto-replies arrive. */}
          <Mono text={envelope.mailFrom || "<>"} />
        </MetaItem>
        <MetaItem label={t("detail.server")}>
          <Mono
            text={[
              envelope.clientIp,
              envelope.helo,
              envelope.tls?.protocol ?? t("detail.noTls"),
            ].join(" · ")}
          />
        </MetaItem>
        <MetaItem label={t("detail.messageId")}>
          <CopyChip value={email.messageId} />
        </MetaItem>
      </div>

      <section style={{ marginTop: 26 }}>
        <div className="ms-microlabel">{te("detail.events")}</div>
        <div className="ms-events" style={{ marginTop: 12 }}>
          {timeline.map((step, index) => (
            <div key={step.key} style={{ display: "contents" }}>
              {index > 0 ? (
                <div className="ms-events-gap">
                  <span className="ms-events-line" />
                </div>
              ) : null}
              <div className="ms-events-node">
                <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ms-bone)" }}>
                  {step.label}
                </span>
                {step.at ? (
                  <span style={{ fontSize: 12, color: "var(--ms-muted)", marginTop: 5 }}>
                    {formatDayTime(step.at, locale)}
                  </span>
                ) : null}
                {step.detail ? (
                  <span
                    className="ms-mono"
                    style={{ fontSize: 11, color: "var(--ms-muted)", marginTop: 3, maxWidth: 220 }}
                  >
                    {step.detail}
                  </span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </section>

      {email.attachments.length > 0 ? (
        <section style={{ marginTop: 26 }}>
          <div className="ms-microlabel">{t("detail.attachments")}</div>
          <div style={{ marginTop: 10 }}>
            <Table>
              <thead>
                <tr>
                  <th>{t("detail.file")}</th>
                  <th style={{ width: "24%" }}>{t("detail.type")}</th>
                  <th className="right" style={{ width: 96 }}>
                    {t("detail.size")}
                  </th>
                  <th className="right" style={{ width: 96 }} />
                </tr>
              </thead>
              <tbody>
                {email.attachments.map((attachment) => (
                  <tr key={attachment.id}>
                    <td className="ms-mono ms-cell-wrap">
                      <Breakable text={attachment.filename ?? t("detail.unnamed")} />
                      {attachment.inline ? (
                        <span
                          className="ms-chip"
                          style={{ fontSize: 10.5, padding: "1px 7px", marginLeft: 8 }}
                        >
                          {t("detail.inline")}
                        </span>
                      ) : null}
                    </td>
                    <td className="ms-mono" style={{ color: "var(--ms-muted)" }}>
                      {attachment.contentType}
                    </td>
                    <td className="right ms-mono">{formatBytes(attachment.size)}</td>
                    <td className="right">
                      {attachment.downloadUrl ? (
                        <a className="ms-link" href={attachment.downloadUrl}>
                          {t("detail.download")}
                        </a>
                      ) : (
                        <span style={{ color: "var(--ms-faint)" }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </section>
      ) : null}

      <div style={{ marginTop: 26 }}>
        <EmailContentPanel
          email={{
            id: email.id,
            subject: email.subject,
            html: email.html,
            text: email.text,
            insights: null,
            bodyPurgedAt: email.contentPurgedAt,
            hiddenBySupportView: email.hiddenBySupportView,
          }}
          received={{ headers: email.headers }}
        />
      </div>

      <ComposeModal
        mode={composer}
        onClose={closeComposer}
        emailId={email.id}
        inboxId={email.memberships.find((m) => m.deliveredAt !== null)?.inboxId}
        cancelLabel={common("cancel")}
        onSent={refresh}
      />
    </>
  );
}

/** Reply to or forward a received email from the address that got it. */
function ComposeModal({
  mode,
  onClose,
  emailId,
  inboxId,
  cancelLabel,
  onSent,
}: {
  mode: "reply" | "forward" | null;
  onClose: () => void;
  emailId: string;
  inboxId: string | undefined;
  cancelLabel: string;
  onSent: () => void;
}) {
  const t = useTranslations("inboxes");
  const trpc = useTRPC();
  const [text, setText] = useState("");
  const [to, setTo] = useState("");
  const [asFile, setAsFile] = useState<"inline" | "attachment">("inline");
  const done = (result: { kind: "sent" } | { kind: "draft" }) => {
    toast(result.kind === "sent" ? t("compose.sent") : t("compose.drafted"));
    setText("");
    setTo("");
    onSent();
    onClose();
  };
  const reply = useMutation(trpc.receiving.reply.mutationOptions({ onSuccess: done }));
  const forward = useMutation(trpc.receiving.forward.mutationOptions({ onSuccess: done }));
  const pending = reply.isPending || forward.isPending;
  const error = reply.error ?? forward.error;
  const recipients = to
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const ready = mode === "reply" ? text.trim().length > 0 : recipients.length > 0;
  const submit = () => {
    if (!ready || pending || !mode) return;
    const scope = inboxId ? { inboxId } : {};
    if (mode === "reply") reply.mutate({ id: emailId, text, ...scope });
    else
      forward.mutate({
        id: emailId,
        to: recipients,
        mode: asFile,
        ...(text ? { text } : {}),
        ...scope,
      });
  };
  return (
    <Modal
      open={mode !== null}
      onClose={onClose}
      onConfirm={submit}
      title={mode === "forward" ? t("detail.forward") : t("detail.reply")}
    >
      <form
        style={{ display: "grid", gap: 14, marginTop: 12 }}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {mode === "forward" ? (
          <>
            <div className="ms-field">
              <label htmlFor="forward-to">{t("compose.to")}</label>
              <input
                id="forward-to"
                className="ms-input mono"
                style={{ width: "100%" }}
                value={to}
                disabled={pending}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setTo(event.target.value)}
              />
            </div>
            <div className="ms-field">
              <label htmlFor="forward-mode">{t("compose.mode")}</label>
              <Select
                id="forward-mode"
                value={asFile}
                onChange={(value) => setAsFile(value === "attachment" ? "attachment" : "inline")}
                width="100%"
                ariaLabel={t("compose.mode")}
                options={[
                  { value: "inline", label: t("compose.inline") },
                  { value: "attachment", label: t("compose.attachment") },
                ]}
              />
            </div>
          </>
        ) : null}
        <div className="ms-field">
          <label htmlFor="compose-text">
            {mode === "forward" ? t("compose.note") : t("compose.message")}
          </label>
          <textarea
            id="compose-text"
            className="ms-input"
            rows={7}
            style={{ width: "100%", resize: "vertical" }}
            value={text}
            disabled={pending}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        {error ? (
          <div className="ms-field-error" style={{ margin: 0 }}>
            {error.message}
          </div>
        ) : null}
        <ModalFooter>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={onClose}>
            {cancelLabel} <span className="ms-keycap">Esc</span>
          </button>
          <button type="submit" className="ms-btn ms-btn-primary" disabled={!ready || pending}>
            <BtnSpinner on={pending} />
            {mode === "forward" ? t("detail.forward") : t("detail.reply")} <ConfirmKeycap />
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
