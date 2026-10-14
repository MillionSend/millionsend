"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useDeferredValue, useEffect, useId, useRef, useState } from "react";
import { DraftBanner } from "@/components/draft-banner";
import { GroupedMultiSelect } from "@/components/grouped-multi-select";
import {
  ArchiveIcon,
  FolderInputIcon,
  SpamIcon,
  TagIcon,
  TrashIcon,
} from "@/components/icons/mail-icons";
import { NavGlyph, RefreshGlyph } from "@/components/icons/nav-icons";
import { MessageEditor } from "@/components/maily-editor/lazy";
import { ConfirmKeycap } from "@/components/modal-footer";
import { PopoverMenu } from "@/components/popover-menu";
import { RelativeTime } from "@/components/relative-time";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner, Spinner } from "@/components/spinner";
import { StatusDot } from "@/components/status-badge";
import { toast } from "@/components/toast";
import { Tooltip } from "@/components/tooltip";
import { addrSpec, formatBytes, formatRelative, senderName } from "@/lib/format";
import { htmlToText } from "@/lib/html";
import { isReadOnly } from "@/lib/read-only";
import { useTRPC } from "@/lib/trpc";
import { oneOf, useUrlState } from "@/lib/url-state";
import { useLocalDraft } from "@/lib/use-local-draft";
import { SearchBox, StateCard } from "../../emails/list-parts";
import {
  approvalReasonWords,
  type InboxDetail,
  messageHref,
  QuarantinedBadge,
  replyAllAdds,
  replyTarget,
  SuspiciousBadge,
  type ThreadMessage,
  type ThreadRow,
  TrustBadge,
} from "../parts";

const FOLDERS = ["inbox", "archive", "spam", "sent", "trash"] as const;
const MOVE_TO = ["inbox", "archive", "spam", "trash"] as const;
const FOLDER_ICONS: Record<(typeof MOVE_TO)[number], React.ReactNode> = {
  inbox: <NavGlyph name="inboxes" size={14} />,
  archive: <ArchiveIcon />,
  spam: <SpamIcon />,
  trash: <TrashIcon />,
};
/** How often the folder's list looks for new mail on its own while it is on screen. */
const LIST_POLL_MS = 60_000;

// Longhands, not the border shorthand: when a card's own borderColor goes away,
// React clears it to "", which would leave the shorthand's border in currentColor.
const card: React.CSSProperties = {
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "var(--ms-line)",
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
      // Not under a support view, which counts every read on its grant, nor past
      // the first page, since each loaded page refetches in turn; "Atualizar" covers both.
      refetchInterval: (list) =>
        !isReadOnly() && (list.state.data?.pages.length ?? 1) <= 1 ? LIST_POLL_MS : false,
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
    <div className="ms-threads">
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
      <div className={threadId ? "ms-thread-split" : undefined}>
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
          // Keyed so a request still in flight for the thread before can't close this one.
          <ThreadPane
            key={threadId}
            inbox={inbox}
            threadId={threadId}
            onClose={() => setThreadId("")}
          />
        ) : null}
      </div>
    </div>
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
  const dot = row.read ? null : (
    <StatusDot id={`${id}-dot`} color="var(--ms-bone)" label={unreadLabel} />
  );
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
        {/* Boxless, so the pills stay the subject line's flex items; the button reads them out. */}
        <span id={`${id}-pills`} style={{ display: "contents" }}>
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
        </span>
        {/* No handler of its own: its click, Enter's included, bubbles to the row. */}
        <button
          type="button"
          className="ms-thread-open"
          aria-current={selected || undefined}
          aria-labelledby={`${id}-from ${id}-title`}
          aria-describedby={dot ? `${id}-dot ${id}-pills` : `${id}-pills`}
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
  const tc = useTranslations("common");
  const router = useRouter();
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
  const createLabel = useMutation(
    trpc.inboxes.labels.create.mutationOptions({
      onSuccess: (label) => {
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
  // Stacked under the list (a phone), the opened thread would start below the fold.
  const paneRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const pane = paneRef.current;
    const list = pane?.previousElementSibling;
    if (pane && list && pane.getBoundingClientRect().top >= list.getBoundingClientRect().bottom) {
      pane.scrollIntoView({ block: "start", behavior: "auto" });
    }
  }, []);

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
  // Messages load oldest first: the newest is known once the last page is in.
  const newest = messages.hasNextPage ? undefined : items[items.length - 1];
  const target = messages.hasNextPage ? undefined : replyTarget(items);
  const summary = thread.data;
  const labelIds = summary?.labels.map((label) => label.id) ?? [];

  return (
    <section ref={paneRef} style={{ display: "grid", gap: 10, alignContent: "start" }}>
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
            {/* An expired inbox is read-only; each message keeps its own link. */}
            {inbox.expired ? null : (
              <>
                <PopoverMenu
                  label={t("moveTo")}
                  ariaLabel={t("moveTo")}
                  align="left"
                  triggerGlyph={<FolderInputIcon />}
                  items={MOVE_TO.filter((folder) => folder !== summary.folder).map((folder) => ({
                    label: t(`folder.${folder}`),
                    icon: FOLDER_ICONS[folder],
                    onSelect: () =>
                      update.mutate(
                        { ...ref, folder },
                        {
                          // The thread has left the list beside it, so the pane goes too.
                          onSuccess: () => {
                            toast(t("movedTo", { folder }));
                            onClose();
                          },
                        },
                      ),
                  }))}
                />
                {/* ponytail: the ✓ follows the refetch, so a second toggle of one label
                    before it lands repeats the first; keep a pending value if that bites. */}
                <GroupedMultiSelect
                  button
                  ariaLabel={t("addLabel")}
                  summary={
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <TagIcon />
                      {t("addLabel")}
                    </span>
                  }
                  value={labelIds}
                  options={(labels.data ?? []).map((label) => ({
                    value: label.id,
                    label: label.name,
                    group: "labels",
                    adornment: <StatusDot color={label.color} />,
                  }))}
                  groups={[{ key: "labels", label: "" }]}
                  searchPlaceholder={t("labelSearch")}
                  noResultsLabel={tc("select.noResults")}
                  // labels.create takes 64 characters at most.
                  maxLength={64}
                  onCreate={(name) => createLabel.mutate({ inboxId: inbox.id, name })}
                  createLabel={(name) => t("createLabel", { name })}
                  onChange={(next) => {
                    // A pick toggles one row: the id that differs says which, and how.
                    const added = next.find((id) => !labelIds.includes(id));
                    const removed = labelIds.find((id) => !next.includes(id));
                    if (added) update.mutate({ ...ref, labelId: added });
                    else if (removed) update.mutate({ ...ref, removeLabelId: removed });
                  }}
                />
                <PopoverMenu
                  boxed
                  ariaLabel={t("more")}
                  items={[
                    {
                      label: t(summary.read ? "markUnread" : "markRead"),
                      onSelect: () =>
                        update.mutate(
                          { ...ref, read: !summary.read },
                          // Back to the list, as a mail client does; left open, a
                          // people inbox would read the thread again at once.
                          summary.read ? { onSuccess: onClose } : undefined,
                        ),
                    },
                    ...(newest
                      ? [
                          {
                            label: t("openEmail"),
                            onSelect: () => router.push(messageHref(newest)),
                          },
                        ]
                      : []),
                  ]}
                />
              </>
            )}
            <button type="button" className="ms-btn ms-btn-ghost" onClick={onClose}>
              {t("close")}
            </button>
          </>
        ) : null}
      </div>
      {summary && summary.labels.length > 0 ? (
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {summary.labels.map((label) => (
            <span key={label.id} className="ms-chip">
              <StatusDot color={label.color} />
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

      {target && !inbox.expired ? (
        <ReplyComposer inbox={inbox} threadId={threadId} target={target} onSent={refresh} />
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
  return (
    <article style={held ? { ...card, borderColor: "var(--ms-danger-border)" } : card}>
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
        href={messageHref(message)}
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

/**
 * Answers `target` (see replyTarget). One instance per thread, since the pane
 * is keyed by thread: a half-written reply stays with the thread it was written in.
 */
function ReplyComposer({
  inbox,
  threadId,
  target,
  onSent,
}: {
  inbox: InboxDetail;
  threadId: string;
  target: ThreadMessage;
  onSent: () => void;
}) {
  const t = useTranslations("inboxes");
  const trpc = useTRPC();
  const [html, setHtml] = useState("");
  // The editor reads its value on mount only: a new nonce reseeds it from html.
  const [nonce, setNonce] = useState(0);
  const reseed = (next: string) => {
    setHtml(next);
    setNonce((n) => n + 1);
  };
  // A send remounts the editor empty; focus goes into the new one, so the
  // keyboard keeps its place. A thread switch remounts this whole composer.
  const [sent, setSent] = useState(false);
  const draft = useLocalDraft({
    storageKey: `ms-draft:inbox-reply:${threadId}`,
    state: html,
    initialState: "",
  });
  const reply = useMutation(
    trpc.inboxes.reply.mutationOptions({
      onSuccess: (result) => {
        toast(result.kind === "sent" ? t("compose.sent") : t("compose.drafted"));
        draft.markSaved("");
        setSent(true);
        reseed("");
        onSent();
      },
      onError: (error) => toast(error.message, "danger"),
    }),
  );
  const text = htmlToText(html);
  const ready = text !== "" && !reply.isPending;
  const others = replyAllAdds(target, inbox);
  const send = (replyAll: boolean) => {
    if (!ready) return;
    reply.mutate({ inboxId: inbox.id, threadId, emailId: target.id, html, text, replyAll });
  };
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div>
        <MessageEditor
          key={nonce}
          value={{ document: null, html }}
          compact={{
            placeholder: t("compose.replyPlaceholder"),
            ariaLabel: t("compose.message"),
            onSubmit: () => send(false),
            autoFocus: sent,
          }}
          onChange={(change) => setHtml(change.html ?? "")}
        />
        {draft.recovered ? (
          <DraftBanner
            savedAt={draft.recovered.savedAt}
            onRestore={() => {
              const recovered = draft.recovered;
              if (!recovered) return;
              reseed(recovered.data);
              draft.acceptRecovered();
            }}
            onDiscard={draft.discardRecovered}
          />
        ) : null}
      </div>
      <span style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        {others.length > 0 ? (
          <Tooltip
            inline
            focusableChild
            text={t("compose.replyAllHint", { addresses: others.join(", ") })}
          >
            <button
              type="button"
              className="ms-btn ms-btn-secondary"
              disabled={!ready}
              onClick={() => send(true)}
            >
              {t("compose.replyAll")}
            </button>
          </Tooltip>
        ) : null}
        <button
          type="button"
          className="ms-btn ms-btn-primary"
          disabled={!ready}
          onClick={() => send(false)}
        >
          <BtnSpinner on={reply.isPending} />
          {t("detail.reply")} <ConfirmKeycap />
        </button>
      </span>
    </div>
  );
}
