"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Breakable } from "@/components/breakable";
import { RelativeTime } from "@/components/relative-time";
import { Skeleton } from "@/components/skeleton";
import { Table } from "@/components/table";
import { toast } from "@/components/toast";
import { useTRPC } from "@/lib/trpc";
import { approvalReasonWords, type InboxDetail, TrustBadge } from "../parts";

const heading: React.CSSProperties = { margin: "0 0 10px" };

/** What waits for a person: sends held for approval, then mail held in quarantine. */
export function ReviewTab({ inbox }: { inbox: InboxDetail }) {
  const t = useTranslations("inboxes");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const drafts = useQuery(trpc.inboxes.drafts.list.queryOptions({ inboxId: inbox.id, limit: 100 }));
  const held = useQuery(
    trpc.inboxes.quarantine.list.queryOptions({ inboxId: inbox.id, limit: 100 }),
  );
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.inboxes.pathKey() });
  };
  const fail = (error: { message: string }) => toast(error.message, "danger");
  const approve = useMutation(
    trpc.inboxes.drafts.approve.mutationOptions({
      onSuccess: (result) => {
        toast(result.kind === "sent" ? t("compose.sent") : t("compose.drafted"));
        refresh();
      },
      onError: fail,
    }),
  );
  const reject = useMutation(
    trpc.inboxes.drafts.reject.mutationOptions({ onSuccess: refresh, onError: fail }),
  );
  const release = useMutation(
    trpc.inboxes.quarantine.release.mutationOptions({ onSuccess: refresh, onError: fail }),
  );
  const busy = approve.isPending || reject.isPending || release.isPending;

  if (drafts.isPending || held.isPending) return <Skeleton width="50%" height={14} />;
  const pending = (drafts.data?.items ?? []).filter((d) => d.status === "pending_approval");
  const quarantined = held.data?.items ?? [];
  if (pending.length === 0 && quarantined.length === 0) {
    return <p style={{ fontSize: 13, color: "var(--ms-muted)" }}>{t("review.empty")}</p>;
  }

  return (
    <div style={{ display: "grid", gap: 26 }}>
      {pending.length > 0 ? (
        <section>
          <h2 className="ms-microlabel" style={heading}>
            {t("review.drafts")}
          </h2>
          <Table>
            <thead>
              <tr>
                <th>{t("review.to")}</th>
                <th>{t("review.subject")}</th>
                <th>{t("review.reasons")}</th>
                <th className="right" />
              </tr>
            </thead>
            <tbody>
              {pending.map((draft) => (
                <tr key={draft.id}>
                  <td className="ms-mono ms-cell-wrap">
                    <Breakable text={(draft.to ?? []).join(", ")} />
                  </td>
                  <td>
                    {draft.thread_id ? (
                      <Link
                        className="ms-link"
                        href={`/inboxes/${inbox.id}?thread=${draft.thread_id}`}
                      >
                        {draft.subject ?? t("noSubject")}
                      </Link>
                    ) : (
                      (draft.subject ?? t("noSubject"))
                    )}
                    {draft.snippet ? (
                      <div style={{ fontSize: 12, color: "var(--ms-muted)" }}>{draft.snippet}</div>
                    ) : null}
                  </td>
                  <td style={{ fontSize: 12.5 }}>
                    {approvalReasonWords(t, draft.approval_reasons)}
                  </td>
                  <td className="right" style={{ whiteSpace: "nowrap" }}>
                    <span style={{ display: "inline-flex", gap: 6 }}>
                      <button
                        type="button"
                        className="ms-btn ms-btn-destructive"
                        disabled={busy}
                        onClick={() => reject.mutate({ inboxId: inbox.id, draftId: draft.id })}
                      >
                        {t("draft.discard")}
                      </button>
                      <button
                        type="button"
                        className="ms-btn ms-btn-primary"
                        disabled={busy}
                        onClick={() => approve.mutate({ inboxId: inbox.id, draftId: draft.id })}
                      >
                        {t("draft.approve")}
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      ) : null}

      {quarantined.length > 0 ? (
        <section>
          <h2 className="ms-microlabel" style={heading}>
            {t("review.quarantine")}
          </h2>
          <Table>
            <thead>
              <tr>
                <th>{t("received.col.from")}</th>
                <th>{t("review.subject")}</th>
                <th>{t("review.reason")}</th>
                {inbox.kind === "agent" ? <th className="right">{t("review.scores")}</th> : null}
                <th className="right">{t("received.col.received")}</th>
                <th className="right" />
              </tr>
            </thead>
            <tbody>
              {quarantined.map((item) => (
                <tr key={item.id}>
                  <td className="ms-mono ms-cell-wrap">
                    <Breakable text={item.from} />
                    <div style={{ marginTop: 4 }}>
                      <TrustBadge trust={item.sender_trust} />
                    </div>
                  </td>
                  <td>
                    <Link className="ms-link" href={`/inboxes/received/${item.id}`}>
                      {item.subject ?? t("noSubject")}
                    </Link>
                  </td>
                  <td style={{ fontSize: 12.5 }}>
                    {t(`qr.${item.quarantine_reason}`)}
                    {item.virus_signature ? (
                      <div className="ms-mono" style={{ color: "var(--ms-muted)" }}>
                        {item.virus_signature}
                      </div>
                    ) : null}
                  </td>
                  {inbox.kind === "agent" ? (
                    <td className="right ms-mono" style={{ whiteSpace: "nowrap" }}>
                      {t("detail.scores", {
                        injection: item.injection_score ?? "–",
                        phishing: item.phishing_score ?? "–",
                      })}
                    </td>
                  ) : null}
                  <td className="right" style={{ whiteSpace: "nowrap" }}>
                    <RelativeTime date={item.received_at} />
                  </td>
                  <td className="right" style={{ whiteSpace: "nowrap" }}>
                    <span style={{ display: "inline-flex", gap: 6 }}>
                      <button
                        type="button"
                        className="ms-btn ms-btn-secondary"
                        disabled={busy || inbox.expired}
                        onClick={() =>
                          release.mutate({ inboxId: inbox.id, emailId: item.id, trustSender: true })
                        }
                      >
                        {t("releaseTrust")}
                      </button>
                      <button
                        type="button"
                        className="ms-btn ms-btn-primary"
                        disabled={busy || inbox.expired}
                        onClick={() =>
                          release.mutate({
                            inboxId: inbox.id,
                            emailId: item.id,
                            trustSender: false,
                          })
                        }
                      >
                        {t("release")}
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      ) : null}
    </div>
  );
}
