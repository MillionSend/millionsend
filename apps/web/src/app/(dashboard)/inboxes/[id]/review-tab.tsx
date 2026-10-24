"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { LeadCell } from "@/components/lead-cell";
import { RelativeTime } from "@/components/relative-time";
import { Skeleton } from "@/components/skeleton";
import { mutedDash, Table } from "@/components/table";
import { toast } from "@/components/toast";
import { Tooltip } from "@/components/tooltip";
import { Truncated } from "@/components/truncated";
import { useTRPC } from "@/lib/trpc";
import { StateCard } from "../../emails/list-parts";
import { approvalReasonWords, type InboxDetail, TrustTile } from "../parts";
import { ReleaseButton } from "../release-dialog";

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
  const busy = approve.isPending || reject.isPending;

  if (drafts.isPending || held.isPending) return <Skeleton width="50%" height={14} />;
  const pending = (drafts.data?.items ?? []).filter((d) => d.status === "pending_approval");
  const quarantined = held.data?.items ?? [];
  if (pending.length === 0 && quarantined.length === 0) {
    return <StateCard headline={t("review.empty")} />;
  }

  return (
    // minmax(0, 1fr): an auto track would grow to a list's one-line width and
    // push the page past a phone's viewport, where the list should scroll.
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 26 }}>
      {pending.length > 0 ? (
        <section>
          <h2 className="ms-microlabel" style={heading}>
            {t("review.drafts")}
          </h2>
          <Table>
            <thead>
              <tr>
                <th style={{ width: "26%" }}>{t("review.to")}</th>
                <th style={{ width: "34%" }}>{t("review.subject")}</th>
                <th style={{ width: "22%" }}>{t("review.reasons")}</th>
                <th className="right" />
              </tr>
            </thead>
            <tbody>
              {pending.map((draft) => (
                <tr key={draft.id}>
                  <LeadCell value={draft.to?.[0] ?? ""} more={draft.to?.slice(1) ?? []} mono />
                  <LeadCell
                    value={draft.subject ?? t("noSubject")}
                    {...(draft.thread_id
                      ? { href: `/inboxes/${inbox.id}?thread=${draft.thread_id}` }
                      : {})}
                    tail={draft.snippet}
                  />
                  <td className="ms-cell-fill" style={{ fontSize: 12.5 }}>
                    <Truncated text={approvalReasonWords(t, draft.approval_reasons)} />
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
                <th style={{ width: "26%" }}>{t("received.col.from")}</th>
                <th style={{ width: "28%" }}>{t("review.subject")}</th>
                <th style={{ width: "16%" }}>{t("review.reason")}</th>
                {inbox.kind === "agent" ? <th className="right">{t("review.scores")}</th> : null}
                <th className="right">{t("received.col.received")}</th>
                <th className="right" />
              </tr>
            </thead>
            <tbody>
              {quarantined.map((item) => (
                <tr key={item.id}>
                  <LeadCell tile={<TrustTile trust={item.sender_trust} />} value={item.from} mono />
                  <LeadCell
                    value={item.subject ?? t("noSubject")}
                    href={`/inboxes/received/${item.id}`}
                  />
                  <td className="ms-cell-fill" style={{ fontSize: 12.5 }}>
                    {item.virus_signature ? (
                      // The signature shows on hover even when the reason is whole.
                      <Tooltip
                        inline
                        triggerClassName="ms-truncate-host"
                        text={`${t(`qr.${item.quarantine_reason}`)}\n${item.virus_signature}`}
                      >
                        <span className="ms-truncate">{t(`qr.${item.quarantine_reason}`)}</span>
                      </Tooltip>
                    ) : (
                      <Truncated text={t(`qr.${item.quarantine_reason}`)} />
                    )}
                  </td>
                  {inbox.kind === "agent" ? (
                    <td className="right ms-mono">
                      {item.injection_score === null && item.phishing_score === null ? (
                        mutedDash
                      ) : (
                        // The figures alone, named on hover: the labels would squeeze From and Subject.
                        <Tooltip
                          inline
                          text={t("review.scoreLine", {
                            injection: item.injection_score ?? "–",
                            phishing: item.phishing_score ?? "–",
                          })}
                        >
                          {`${item.injection_score ?? "–"} · ${item.phishing_score ?? "–"}`}
                        </Tooltip>
                      )}
                    </td>
                  ) : null}
                  <td className="right" style={{ whiteSpace: "nowrap" }}>
                    <RelativeTime date={item.received_at} />
                  </td>
                  <td className="right" style={{ whiteSpace: "nowrap" }}>
                    <ReleaseButton
                      kind={inbox.kind}
                      target={{ inboxId: inbox.id, emailId: item.id }}
                      disabled={inbox.expired}
                      onChange={refresh}
                    />
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
