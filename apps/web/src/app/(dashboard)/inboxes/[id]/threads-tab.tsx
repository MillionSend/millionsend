"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useDeferredValue, useEffect, useId, useState } from "react";
import { RefreshGlyph } from "@/components/icons/nav-icons";
import { RelativeTime } from "@/components/relative-time";
import { Select } from "@/components/select";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner, Spinner } from "@/components/spinner";
import { StatusDot } from "@/components/status-badge";
import { toast } from "@/components/toast";
import { Tooltip } from "@/components/tooltip";
import { addrSpec, formatBytes, formatRelative, senderName } from "@/lib/format";
import { isReadOnly } from "@/lib/read-only";
import { useTRPC } from "@/lib/trpc";
import { oneOf, useUrlState } from "@/lib/url-state";
import { SearchBox, StateCard } from "../../emails/list-parts";
import {
  approvalReasonWords,
  type InboxDetail,
  QuarantinedBadge,
  SuspiciousBadge,
  type ThreadMessage,
  type ThreadRow,
  TrustBadge,
} from "../parts";

const FOLDERS = ["inbox", "archive", "spam", "sent", "trash"] as const;
const MOVE_TO = ["inbox", "archive", "spam", "trash"] as const;
const NEW_LABEL = "new";
/** How often the folder's list looks for new mail on its own while it is on screen. */
const LIST_POLL_MS = 60_000;

const card: React.CSSProperties = {
  border: "1px solid var(--ms-line)",
  borderRadius: 12,
  background: "var(--ms-panel)",
  padding: "14px 16px",
};
const muted: React.CSSProperties = { fontSize: 12, color: "var(--ms-muted)" };

export function ThreadsTab({ inbox }: { inbox: InboxDetail }) {
  const t = useTranslations("inboxes");
  const tc = useTranslations("common");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [folderParam, setFolder] = useUrlState("folder", "inbox");
  const folder = oneOf(FOLDERS, folderParam, "inbox");
  const [threadId, setThreadId] = useUrlState("thread");
  const [search, setSearch] = useState("");
  // Only a click shows the spinner: the poll below stays quiet.
  const [refreshing, setRefreshing] = useState(false);
  const query = useDeferredValue(search.trim());
  const base = { inboxId: inbox.id, folders: [folder], limit: 50 };
  const listed = useInfiniteQuery(
    trpc.inboxes.threads.list.infiniteQueryOptions(base, {
      getNextPageParam: (page) => page.nextCursor,
      enabled: query === "",
      refetchInterval: LIST_POLL_MS,
    }),
  );
  const searched = useInfiniteQuery(
    trpc.inboxes.threads.search.infiniteQueryOptions(
      { ...base, query },
      { getNextPageParam: (page) => page.nextCursor, enabled: query !== "" },
    ),
  );
  const active = query === "" ? listed : searched;
  const rows: ThreadRow[] = active.data?.pages.flatMap((page) => page.items) ?? [];
  // Everything on screen reloads: the list, the header's counts and an open thread.
  const refresh = () => {
    setRefreshing(true);
    void queryClient
      .invalidateQueries(trpc.inboxes.pathFilter())
      .finally(() => setRefreshing(false));
  };

  return (
    <>
      <div
        className="ms-filter-row"
        style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14 }}
      >
        {/* Folders filter the list under them, which is no tabpanel: pressed buttons, not tabs. */}
        <div className="ms-tabs">
          {FOLDERS.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={folder === key}
              className={folder === key ? "active" : undefined}
              onClick={() => setFolder(key)}
            >
              {t(`folder.${key}`)}
            </button>
          ))}
        </div>
        <SearchBox value={search} onChange={setSearch} placeholder={t("search")} />
        <Tooltip inline focusableChild text={tc("refresh")}>
          <button
            type="button"
            className="ms-btn ms-btn-icon"
            aria-label={tc("refresh")}
            onClick={refresh}
          >
            {refreshing ? <Spinner size={14} /> : <RefreshGlyph />}
          </button>
        </Tooltip>
      </div>
      <div className={threadId ? "ms-grid ms-grid-12" : undefined}>
        <div>
          {active.isPending ? (
            <ul className="ms-thread-list" aria-hidden="true">
              {["58%", "42%", "66%"].map((width) => (
                <li key={width} className="ms-thread-row">
                  <span className="ms-thread-from">
                    <Skeleton width="70%" height={13} />
                  </span>
                  <span className="ms-thread-subject">
                    <Skeleton width={width} height={13} />
                  </span>
                  <span className="ms-thread-time">
                    <Skeleton width={48} />
                  </span>
                </li>
              ))}
            </ul>
          ) : active.isError ? (
            <StateCard
              tone="error"
              headline={t("threadsError")}
              actionLabel={t("retry")}
              onAction={() => active.refetch()}
            />
          ) : rows.length === 0 ? (
            <StateCard headline={t("emptyFolder")} />
          ) : (
            <>
              <ul className="ms-thread-list">
                {rows.map((row) => (
                  <ThreadListRow
                    key={row.id}
                    row={row}
                    agent={inbox.kind === "agent"}
                    sent={folder === "sent"}
                    selected={row.id === threadId}
                    onOpen={() => setThreadId(row.id)}
                  />
                ))}
              </ul>
              {active.hasNextPage ? (
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
                  <button
                    type="button"
                    className="ms-btn ms-btn-secondary"
                    disabled={active.isFetchingNextPage}
                    onClick={() => active.fetchNextPage()}
                  >
                    {t("loadMore")}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
        {threadId ? (
          <ThreadPane inbox={inbox} threadId={threadId} onClose={() => setThreadId("")} />
        ) : null}
      </div>
    </>
  );
}

/** One line per thread; only what asks for action gets a pill. */
export function ThreadListRow({
  row,
  agent,
  sent,
  selected,
  onOpen,
}: {
  row: ThreadRow;
  agent: boolean;
  /** The Sent folder names the recipient: there every sender is this inbox. */
  sent: boolean;
  selected: boolean;
  onOpen: () => void;
}) {
  const t = useTranslations("inboxes");
  const id = useId();
  const unreadLabel = t(agent ? "unreadAgent" : "unread");
  const dot = row.read ? null : <StatusDot color="var(--ms-bone)" label={unreadLabel} />;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the row only widens its button's click; keyboard users reach the button
    <li className={row.read ? "ms-thread-row" : "ms-thread-row unread"} onClick={onOpen}>
      {/* An agent's unread is its queue, not the person's: the dot says so on hover. */}
      {dot && agent ? (
        <Tooltip inline text={unreadLabel}>
          {dot}
        </Tooltip>
      ) : (
        dot
      )}
      <span className="ms-thread-from">
        <span id={`${id}-from`} className="ms-thread-name">
          {sent
            ? t("compose.toName", { name: senderName(row.to[0] ?? null) })
            : senderName(row.from) || t("noSender")}
        </span>
        {row.message_count > 1 ? <span className="ms-count">{row.message_count}</span> : null}
      </span>
      <span className="ms-thread-subject">
        {row.pending_approval ? (
          <span className="ms-badge ms-badge-warn">{t("badge.draft")}</span>
        ) : null}
        {row.quarantined > 0 ? (
          <QuarantinedBadge reason={row.quarantine_reason} />
        ) : agent && row.suspicious ? (
          <SuspiciousBadge injection={row.injection_score} phishing={row.phishing_score} />
        ) : null}
        {row.labels.map((label) => (
          <span key={label.id} className="ms-badge ms-badge-neutral">
            <StatusDot color={label.color} />
            {label.name}
          </span>
        ))}
        {/* No handler of its own: its click, Enter's included, bubbles to the row. */}
        <button
          type="button"
          className="ms-thread-open"
          aria-current={selected || undefined}
          aria-labelledby={`${id}-from ${id}-title`}
        >
          <span className="ms-thread-text">
            <span id={`${id}-title`} className="ms-thread-title">
              {row.subject ?? t("noSubject")}
            </span>
            {row.snippet ? <span className="ms-thread-snippet"> — {row.snippet}</span> : null}
          </span>
        </button>
      </span>
      <span className="ms-thread-time">
        <RelativeTime date={row.received_at} />
      </span>
    </li>
  );
}

function ThreadPane({
  inbox,
  threadId,
  onClose,
}: {
  inbox: InboxDetail;
  threadId: string;
  onClose: () => void;
}) {
  const t = useTranslations("inboxes");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const ref = { inboxId: inbox.id, threadId };
  const thread = useQuery(trpc.inboxes.threads.get.queryOptions(ref, { retry: false }));
  const messages = useInfiniteQuery(
    trpc.inboxes.threads.emails.infiniteQueryOptions(
      { ...ref, limit: 50 },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  );
  const drafts = useQuery(trpc.inboxes.drafts.list.queryOptions({ inboxId: inbox.id, limit: 100 }));
  const labels = useQuery(trpc.inboxes.labels.list.queryOptions({ inboxId: inbox.id }));
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.inboxes.threads.pathKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.inboxes.drafts.pathKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.inboxes.get.queryKey({ id: inbox.id }) });
  };
  const update = useMutation(
    trpc.inboxes.threads.update.mutationOptions({
      onSuccess: refresh,
      onError: (error) => toast(error.message, "danger"),
    }),
  );
  // A label made here is applied to the open thread at once.
  const [naming, setNaming] = useState<string | null>(null);
  const createLabel = useMutation(
    trpc.inboxes.labels.create.mutationOptions({
      onSuccess: (label) => {
        setNaming(null);
        void queryClient.invalidateQueries({ queryKey: trpc.inboxes.labels.pathKey() });
        update.mutate({ ...ref, labelId: label.id });
      },
      onError: (error) => toast(error.message, "danger"),
    }),
  );
  const unread = thread.data?.read === false;
  const { mutate } = update;
  // In a people inbox opening a thread reads it, as a mail client does. In an
  // agent inbox unread is the agent's queue of mail to handle, so a person
  // looking leaves it be; a support view reads without writing.
  useEffect(() => {
    if (unread && inbox.kind === "human" && !inbox.expired && !isReadOnly()) {
      mutate({ inboxId: inbox.id, threadId, read: true });
    }
  }, [unread, inbox.kind, inbox.expired, inbox.id, threadId, mutate]);

  if (thread.isError) {
    return (
      <StateCard
        tone="error"
        headline={t("threadError")}
        actionLabel={t("close")}
        onAction={onClose}
      />
    );
  }
  const items = messages.data?.pages.flatMap((page) => page.items) ?? [];
  const pending = (drafts.data?.items ?? []).filter(
    (draft) => draft.thread_id === threadId && draft.status === "pending_approval",
  );
  const latest = items[items.length - 1];
  const summary = thread.data;

  return (
    <section style={{ display: "grid", gap: 10, alignContent: "start" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <h2
          className="ms-display"
          style={{
            fontSize: "var(--ms-fs-h2)",
            margin: 0,
            color: "var(--ms-bone)",
            flex: "1 1 14rem",
          }}
        >
          {summary ? (summary.subject ?? t("noSubject")) : <Skeleton width={220} height={18} />}
        </h2>
        {summary ? (
          <>
            {/* Action choosers: the empty value is the prompt, picking runs the move. */}
            <Select
              value=""
              onChange={(folder) => {
                const to = MOVE_TO.find((f) => f === folder);
                if (to) update.mutate({ ...ref, folder: to });
              }}
              width={150}
              disabled={inbox.expired || update.isPending}
              ariaLabel={t("moveTo")}
              options={[
                { value: "", label: t("moveTo") },
                ...MOVE_TO.filter((folder) => folder !== summary.folder).map((folder) => ({
                  value: folder,
                  label: t(`folder.${folder}`),
                })),
              ]}
            />
            <Select
              value=""
              onChange={(labelId) => {
                if (labelId === NEW_LABEL) setNaming("");
                else if (labelId) update.mutate({ ...ref, labelId });
              }}
              width={150}
              disabled={inbox.expired || update.isPending}
              ariaLabel={t("addLabel")}
              options={[
                { value: "", label: t("addLabel") },
                ...(labels.data ?? [])
                  .filter((label) => !summary.labels.some((l) => l.id === label.id))
                  .map((label) => ({ value: label.id, label: label.name })),
                { value: NEW_LABEL, label: t("newLabel") },
              ]}
            />
            <button type="button" className="ms-btn ms-btn-secondary" onClick={onClose}>
              {t("close")}
            </button>
          </>
        ) : null}
      </div>
      {naming !== null ? (
        <form
          style={{ display: "flex", gap: 8 }}
          onSubmit={(event) => {
            event.preventDefault();
            if (naming.trim()) createLabel.mutate({ inboxId: inbox.id, name: naming.trim() });
          }}
        >
          <input
            className="ms-input"
            style={{ flex: "1 1 auto", minWidth: 0 }}
            value={naming}
            maxLength={64}
            aria-label={t("newLabel")}
            placeholder={t("newLabelPlaceholder")}
            disabled={createLabel.isPending}
            onChange={(event) => setNaming(event.target.value)}
          />
          <button
            type="submit"
            className="ms-btn ms-btn-secondary"
            disabled={!naming.trim() || createLabel.isPending}
          >
            {t("addLabelSubmit")}
          </button>
        </form>
      ) : null}
      {summary && summary.labels.length > 0 ? (
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {summary.labels.map((label) => (
            <span key={label.id} className="ms-chip">
              <span className="ms-dot" style={{ background: label.color }} aria-hidden="true" />
              {label.name}
              <button
                type="button"
                aria-label={t("removeLabel", { label: label.name })}
                disabled={inbox.expired}
                onClick={() => update.mutate({ ...ref, removeLabelId: label.id })}
              >
                ✕
              </button>
            </span>
          ))}
        </span>
      ) : null}

      {messages.isPending ? (
        <div style={card}>
          <Skeleton width="60%" />
        </div>
      ) : (
        items.map((message) => (
          <MessageCard key={message.id} message={message} inbox={inbox} onChange={refresh} />
        ))
      )}
      {messages.hasNextPage ? (
        <button
          type="button"
          className="ms-btn ms-btn-secondary"
          disabled={messages.isFetchingNextPage}
          onClick={() => messages.fetchNextPage()}
        >
          {t("newerMessages")}
        </button>
      ) : null}

      {pending.map((draft) => (
        <DraftCard
          key={draft.id}
          inboxId={inbox.id}
          draftId={draft.id}
          reasons={draft.approval_reasons}
          onChange={refresh}
        />
      ))}

      {latest && !inbox.expired ? (
        <ReplyComposer
          inboxId={inbox.id}
          threadId={threadId}
          emailId={latest.id}
          onSent={refresh}
        />
      ) : null}
    </section>
  );
}

function MessageCard({
  message,
  inbox,
  onChange,
}: {
  message: ThreadMessage;
  inbox: InboxDetail;
  onChange: () => void;
}) {
  const t = useTranslations("inboxes");
  const trpc = useTRPC();
  const release = useMutation(
    trpc.inboxes.quarantine.release.mutationOptions({
      onSuccess: onChange,
      onError: (error) => toast(error.message, "danger"),
    }),
  );
  const inbound = message.direction === "inbound";
  const verdict = inbound ? message.screening.verdict : null;
  const held = verdict === "quarantined";
  const href = inbound ? `/inboxes/received/${message.id}` : `/emails/${message.id}`;
  return (
    <article style={{ ...card, borderColor: held ? "var(--ms-danger-border)" : undefined }}>
      <header style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, color: "var(--ms-bone)" }}>{senderName(message.from)}</span>
        <span className="ms-mono" style={muted}>
          {addrSpec(message.from)}
        </span>
        {inbound ? (
          <>
            <TrustBadge trust={message.screening.sender_trust} />
            {held ? <QuarantinedBadge reason={message.screening.quarantine_reason} /> : null}
            {inbox.kind === "agent" && verdict === "suspicious" ? (
              <SuspiciousBadge
                injection={message.screening.injection_score}
                phishing={message.screening.phishing_score}
              />
            ) : null}
            {message.screening.hidden_text_removed ? (
              <span className="ms-badge ms-badge-warn">{t("message.hiddenText")}</span>
            ) : null}
          </>
        ) : (
          <span className="ms-badge ms-badge-neutral">{message.status}</span>
        )}
        <span style={{ ...muted, marginLeft: "auto" }}>
          <RelativeTime date={message.received_at} />
        </span>
      </header>
      {held ? (
        <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
          <p style={{ margin: 0, fontSize: 13, color: "var(--ms-danger)" }}>
            {t("message.quarantined")}
          </p>
          <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="ms-btn ms-btn-primary"
              disabled={release.isPending || inbox.expired}
              onClick={() =>
                release.mutate({ inboxId: inbox.id, emailId: message.id, trustSender: false })
              }
            >
              <BtnSpinner on={release.isPending} />
              {t("release")}
            </button>
            <button
              type="button"
              className="ms-btn ms-btn-secondary"
              disabled={release.isPending || inbox.expired}
              onClick={() =>
                release.mutate({ inboxId: inbox.id, emailId: message.id, trustSender: true })
              }
            >
              {t("releaseTrust")}
            </button>
          </span>
        </div>
      ) : verdict === "pending" ? (
        <p style={{ margin: "10px 0 0", fontSize: 13, color: "var(--ms-muted)" }}>
          {t("message.screening")}
        </p>
      ) : null}
      {message.text ? (
        <p
          style={{
            margin: "10px 0 0",
            fontSize: 13.5,
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {message.text}
        </p>
      ) : null}
      {message.attachments.length > 0 ? (
        <ul style={{ margin: "10px 0 0", padding: 0, listStyle: "none", ...muted }}>
          {message.attachments.map((attachment) => (
            <li key={attachment.id} className="ms-mono">
              {attachment.filename ?? t("detail.unnamed")}
              {attachment.size !== null ? ` · ${formatBytes(attachment.size)}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      <Link
        href={href}
        className="ms-link"
        style={{ display: "inline-block", marginTop: 10, fontSize: 12.5 }}
      >
        {t("openEmail")}
      </Link>
    </article>
  );
}

function DraftCard({
  inboxId,
  draftId,
  reasons,
  onChange,
}: {
  inboxId: string;
  draftId: string;
  reasons: string[];
  onChange: () => void;
}) {
  const t = useTranslations("inboxes");
  const locale = useLocale();
  const trpc = useTRPC();
  const draft = useQuery(trpc.inboxes.drafts.get.queryOptions({ inboxId, draftId }));
  const [editing, setEditing] = useState<string | null>(null);
  const fail = (error: { message: string }) => toast(error.message, "danger");
  const approve = useMutation(
    trpc.inboxes.drafts.approve.mutationOptions({
      onSuccess: (result) => {
        toast(result.kind === "sent" ? t("compose.sent") : t("compose.drafted"));
        onChange();
      },
      onError: fail,
    }),
  );
  const reject = useMutation(
    trpc.inboxes.drafts.reject.mutationOptions({ onSuccess: onChange, onError: fail }),
  );
  const save = useMutation(
    trpc.inboxes.drafts.update.mutationOptions({
      onSuccess: () => {
        setEditing(null);
        onChange();
      },
      onError: fail,
    }),
  );
  const busy = approve.isPending || reject.isPending || save.isPending;
  const body = draft.data?.text ?? "";
  return (
    <article style={{ ...card, borderColor: "var(--ms-warn-border)" }}>
      <header style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
        <span style={{ fontWeight: 600, color: "var(--ms-warn)" }}>{t("draft.title")}</span>
        <span style={muted}>{approvalReasonWords(t, reasons)}</span>
        {draft.data ? (
          <span style={{ ...muted, marginLeft: "auto" }}>
            {t("draft.created", { time: formatRelative(draft.data.created_at, locale) })}
          </span>
        ) : null}
      </header>
      {editing !== null ? (
        <textarea
          className="ms-input"
          rows={6}
          style={{ width: "100%", marginTop: 10, resize: "vertical" }}
          value={editing}
          disabled={busy}
          onChange={(event) => setEditing(event.target.value)}
        />
      ) : (
        <p style={{ margin: "10px 0 0", fontSize: 13.5, whiteSpace: "pre-wrap", lineHeight: 1.55 }}>
          {draft.isPending ? <Skeleton width="70%" /> : body}
        </p>
      )}
      <span style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <button
          type="button"
          className="ms-btn ms-btn-destructive"
          disabled={busy}
          onClick={() => reject.mutate({ inboxId, draftId })}
        >
          {t("draft.discard")}
        </button>
        {editing === null ? (
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            disabled={busy || draft.isPending}
            onClick={() => setEditing(body)}
          >
            {t("draft.edit")}
          </button>
        ) : (
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            disabled={busy || editing.trim() === ""}
            onClick={() => save.mutate({ inboxId, draftId, patch: { text: editing } })}
          >
            {t("draft.save")}
          </button>
        )}
        <button
          type="button"
          className="ms-btn ms-btn-primary"
          disabled={busy || editing !== null}
          onClick={() => approve.mutate({ inboxId, draftId })}
        >
          <BtnSpinner on={approve.isPending} />
          {t("draft.approve")}
        </button>
      </span>
    </article>
  );
}

function ReplyComposer({
  inboxId,
  threadId,
  emailId,
  onSent,
}: {
  inboxId: string;
  threadId: string;
  emailId: string;
  onSent: () => void;
}) {
  const t = useTranslations("inboxes");
  const trpc = useTRPC();
  const [text, setText] = useState("");
  const [replyAll, setReplyAll] = useState(false);
  const reply = useMutation(
    trpc.inboxes.reply.mutationOptions({
      onSuccess: (result) => {
        toast(result.kind === "sent" ? t("compose.sent") : t("compose.drafted"));
        setText("");
        onSent();
      },
      onError: (error) => toast(error.message, "danger"),
    }),
  );
  const submit = () => {
    if (!text.trim() || reply.isPending) return;
    reply.mutate({ inboxId, threadId, emailId, text, replyAll });
  };
  return (
    <form
      style={{ ...card, display: "grid", gap: 10 }}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        className="ms-input"
        rows={4}
        style={{ width: "100%", resize: "vertical" }}
        placeholder={t("compose.replyPlaceholder")}
        aria-label={t("detail.reply")}
        value={text}
        disabled={reply.isPending}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <span style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "flex-end" }}>
        <label style={{ ...muted, display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={replyAll}
            onChange={(event) => setReplyAll(event.target.checked)}
          />
          {t("compose.replyAll")}
        </label>
        <button
          type="submit"
          className="ms-btn ms-btn-primary"
          disabled={!text.trim() || reply.isPending}
        >
          <BtnSpinner on={reply.isPending} />
          {t("detail.reply")}
        </button>
      </span>
    </form>
  );
}
