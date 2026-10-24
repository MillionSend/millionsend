"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Breakable } from "@/components/breakable";
import { confirmDialog } from "@/components/confirm-dialog";
import { CopyChip } from "@/components/copy-chip";
import { DotParts } from "@/components/dot-parts";
import { EmailContentPanel } from "@/components/email-content-panel";
import {
  EventGap,
  EventNode,
  EventStripSkeleton,
  type ReceivedEventStep,
  receivedEventLook,
} from "@/components/email-status-icon";
import { LeadCell } from "@/components/lead-cell";
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
import { Truncated } from "@/components/truncated";
import {
  AUTH_CHECKS,
  authenticatedSender,
  dkimSignerDomains,
  grayExplanation,
} from "@/lib/auth-result";
import { formatBytes, formatRelative, mailDomain } from "@/lib/format";
import { statusGlow } from "@/lib/status-glow";
import { useTRPC } from "@/lib/trpc";
import { useTeamRole } from "@/lib/use-team-role";
import type { AppRouter } from "@/server/routers";
import { heldWhy, QuarantinedBadge, TrustBadge } from "../../parts";
import { ReleaseButton } from "../../release-dialog";
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

function Banner({
  tone,
  glow = false,
  children,
}: {
  tone: "danger" | "warn";
  /** The status wash, for the banner that is the page's loudest thing. */
  glow?: boolean;
  children: React.ReactNode;
}) {
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
        ...(glow ? { backgroundColor: "var(--ms-ground)", backgroundImage: statusGlow(tone) } : {}),
      }}
    >
      {children}
    </div>
  );
}

/** Mirrors the loaded page's boxes (header, meta grid, events strip, content panel). */
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
          <span style={{ display: "grid", gap: 6 }}>
            {AUTH_CHECKS.map((check) => (
              <span key={check}>
                <SkeletonBadge width={{ spf: 70, dkim: 76, dmarc: 84, arc: 72 }[check]} />
              </span>
            ))}
          </span>
        </MetaItem>
      </div>
      <section style={{ marginTop: 26 }}>
        <div className="ms-microlabel">{t("detail.events")}</div>
        <EventStripSkeleton />
      </section>
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

type ReceivedEmail = inferRouterOutputs<AppRouter>["receiving"]["get"];

/**
 * received → scanned → screened → delivered / quarantined / released →
 * replied / forwarded → webhook, each with what is known of it, on the sent
 * strip's nodes. A scan or a screening has no time of its own.
 */
export function ReceivedEvents({
  email,
}: {
  email: Pick<
    ReceivedEmail,
    "createdAt" | "spam" | "virus" | "memberships" | "activity" | "webhook"
  >;
}) {
  const t = useTranslations("inboxes");
  const te = useTranslations("emails");
  const common = useTranslations("common");
  const timeline: {
    key: string;
    step: ReceivedEventStep;
    label: string;
    detail?: React.ReactNode;
    at?: Date | string;
  }[] = [
    {
      key: "received",
      step: { type: "received" },
      label: t("timeline.received"),
      at: email.createdAt,
    },
  ];
  if (email.virus.verdict || email.spam.verdict) {
    timeline.push({
      key: "scanned",
      step: { type: "scanned", spam: email.spam.verdict, virus: email.virus.verdict },
      label: t("timeline.scanned"),
      detail: [
        ...(email.spam.verdict ? [t(`spam.${email.spam.verdict}`)] : []),
        email.virus.verdict === "fail"
          ? t("virus.fail", { signature: email.virus.signature ?? "" })
          : t(`virus.${email.virus.verdict ?? "none"}`),
      ].join(" · "),
    });
  }
  for (const m of email.memberships) {
    if (m.injectionScore !== null || m.phishingScore !== null) {
      timeline.push({
        key: `screened-${m.inboxId}`,
        step: { type: "screened", verdict: m.verdict, quarantineReason: m.quarantineReason },
        label: t("timeline.screened"),
        detail: t("review.scoreLine", {
          injection: m.injectionScore ?? "–",
          phishing: m.phishingScore ?? "–",
        }),
      });
    }
    if (m.quarantinedAt) {
      timeline.push({
        key: `quarantined-${m.inboxId}`,
        step: { type: "quarantined" },
        label: t("timeline.quarantined"),
        detail: m.quarantineReason ? t(`qr.${m.quarantineReason}`) : m.address,
        at: m.quarantinedAt,
      });
    }
    if (m.releasedAt) {
      timeline.push({
        key: `released-${m.inboxId}`,
        step: { type: "released" },
        label: t("timeline.released"),
        detail: m.releasedByName ? t("timeline.releasedBy", { who: m.releasedByName }) : null,
        at: m.releasedAt,
      });
    }
    if (m.deliveredAt) {
      timeline.push({
        key: `delivered-${m.inboxId}`,
        step: { type: "delivered" },
        label: common("status.delivered"),
        detail: <Breakable text={m.address} />,
        at: m.deliveredAt,
      });
    }
  }
  for (const [index, a] of email.activity.filter((x) => x.action !== "email.released").entries()) {
    const type = a.action === "email.forwarded" ? "forwarded" : "replied";
    timeline.push({
      key: `activity-${index}`,
      step: { type },
      label: t(`timeline.${type}`),
      detail: a.by,
      at: a.at,
    });
  }
  if (email.webhook) {
    timeline.push({
      key: "webhook",
      step: { type: "webhook", status: email.webhook.status },
      label: t("timeline.webhook"),
      detail: `email.received · ${email.webhook.responseCode ?? email.webhook.status}`,
      at: email.webhook.at,
    });
  }
  const times = timeline.map((entry) => (entry.at ? new Date(entry.at).getTime() : null));
  // The strip keeps the pipeline's order, so the newest step is the latest in
  // time (a webhook listed after a later reply is not), or the last one while
  // the strip ends on a scan or screening with nothing after it yet.
  const newest =
    times.at(-1) === null
      ? times.length - 1
      : times.lastIndexOf(Math.max(...times.map((time) => time ?? Number.NEGATIVE_INFINITY)));
  // Wider than the page (a message held, released and delivered), the strip
  // opens on its end: the latest step is what the page was opened for.
  const strip = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies(timeline.length): only a new step moves it; a refetch leaves the reader's scroll be
  useLayoutEffect(() => {
    const el = strip.current;
    if (el && el.scrollWidth > el.clientWidth) el.scrollLeft = el.scrollWidth;
  }, [timeline.length]);
  return (
    <section style={{ marginTop: 26 }}>
      <div className="ms-microlabel">{te("detail.events")}</div>
      <div ref={strip} className="ms-events">
        {timeline.map((entry, index) => {
          const { color, glyph } = receivedEventLook(entry.step);
          const at = times[index] ?? null;
          const since = times.slice(0, index).findLast((time) => time !== null) ?? null;
          return (
            <div key={entry.key} style={{ display: "contents" }}>
              {index > 0 ? (
                <EventGap ms={at !== null && since !== null ? at - since : null} />
              ) : null}
              <EventNode
                type={entry.step.type}
                color={color}
                glyph={glyph}
                label={entry.label}
                at={entry.at}
                detail={entry.detail}
                wrapDetail
                latest={index === newest}
              />
            </div>
          );
        })}
      </div>
    </section>
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
  // Held in two inboxes, the banner releases one at a time, the dialog naming which.
  const held = email.memberships.find((m) => m.verdict === "quarantined");
  const pending = email.memberships.some((m) => m.verdict === "pending");
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
  // A held catch-all row belongs to no inbox: a virus holds it, before any screening.
  const why = heldWhy(
    t,
    held
      ? {
          reason: held.quarantineReason,
          injectionScore: held.injectionScore,
          phishingScore: held.phishingScore,
          reasons: held.reasons,
        }
      : { reason: "virus", injectionScore: null, phishingScore: null, reasons: [] },
    true,
  );
  // The team's API reads a released catch-all row, so it is worded as an agent's mail.
  const kind = held?.kind ?? "agent";

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
        <Banner tone="danger" glow>
          <span style={{ flex: "1 1 18rem", display: "grid", gap: 3 }}>
            <span>{t("message.quarantined", { kind })}</span>
            {why ? (
              <span style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--ms-muted)" }}>
                <DotParts text={why} />
              </span>
            ) : null}
          </span>
          <ReleaseButton
            kind={kind}
            target={held ? { inboxId: held.inboxId, emailId: email.id } : { catchAllId: email.id }}
            onChange={refresh}
          />
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

      <ReceivedEvents email={email} />

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
                    <LeadCell
                      value={attachment.filename ?? t("detail.unnamed")}
                      mono
                      tail={attachment.inline ? t("detail.inline") : undefined}
                    />
                    <td className="ms-cell-fill ms-mono" style={{ color: "var(--ms-muted)" }}>
                      <Truncated text={attachment.contentType} />
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
          received={{
            headers: email.headers,
            domain: mailDomain(email.from),
            authenticated: authenticatedSender(email.senderTrust),
          }}
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
