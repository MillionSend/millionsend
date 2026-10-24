"use client";

import type { MediaLinkSource } from "@millionsend/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { Modal } from "@/components/modal";
import { ModalFooter } from "@/components/modal-footer";
import { RelativeTime } from "@/components/relative-time";
import { BtnSpinner } from "@/components/spinner";
import { Table } from "@/components/table";
import { toast } from "@/components/toast";
import { formatBytes, formatMmSs } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";
import { useCountdown } from "@/lib/use-countdown";
import { RevealText, WHY_DOT } from "./parts";
import type { RevealTeam } from "./reveal";

const SOURCE_KEYS: Record<MediaLinkSource, string> = {
  "QR code": "qr",
  "PDF link": "pdf",
  "Office link": "office",
  "pass link": "pass",
  "calendar link": "calendar",
  "web page link": "page",
};
const LABEL: React.CSSProperties = { marginBottom: 4 };
const NOTE: React.CSSProperties = { margin: "0 0 14px", fontSize: 13, color: "var(--ms-muted)" };
const PREVIEW: React.CSSProperties = {
  display: "block",
  width: "100%",
  height: 180,
  objectFit: "contain",
  background: "var(--ms-inset)",
  border: "1px solid var(--ms-line)",
  borderRadius: "var(--ms-r-input)",
};

/**
 * What screening read from a held email's images and attachments, opened
 * from the review list under a live grant: why it waits, the text read, the
 * links with their domains' age, the files and the previews the worker
 * redrew. Asked once, as the revealed text is, since every view counts on
 * the grant. Its one action releases every waiting email of the team with
 * the same media.
 */
export function MediaPanel({
  team,
  grantId,
  emailId,
  onClose,
  onChanged,
}: {
  team: RevealTeam;
  grantId: string;
  emailId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations("console.safety.media");
  const view = useTranslations("console.safety.reveal.view");
  const waiting = useTranslations("console.safety.waiting");
  const common = useTranslations("console.common");
  const locale = useLocale();
  const nf = new Intl.NumberFormat(locale);
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.console.safety.media.queryOptions({ grantId, emailId }),
    staleTime: "static",
    gcTime: 0,
    retry: false,
  });
  const release = useMutation(trpc.console.safety.releaseSameMedia.mutationOptions());
  const left = useCountdown(query.data?.expiresAt ?? null);
  const data = query.data;
  const expired = data !== undefined && left === 0;
  const errorMessage = query.error?.message;

  const releaseSame = (parkedBefore: Date) =>
    release.mutate(
      { teamId: team.id, emailId, parkedBefore },
      {
        onSuccess: ({ released }) => {
          toast(waiting("toast.released", { team: team.name, count: released }));
          onClose();
          onChanged();
        },
        onError: (error) => toast(waiting("toast.error", { message: error.message }), "danger"),
      },
    );

  return (
    <Modal open onClose={onClose} size="wide" title={t("title", { team: team.name })}>
      <p style={{ margin: "6px 0 14px", color: "var(--ms-muted)", fontSize: 13.5 }}>{t("lead")}</p>
      {query.isError ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--ms-danger)" }}>
          {errorMessage === "expired"
            ? view("expired")
            : errorMessage === "purged"
              ? view("purged")
              : view("failed")}
        </p>
      ) : !data ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--ms-muted)" }}>…</p>
      ) : expired ? (
        // The window's promise holds for an open panel too: what it fetched hides with it.
        <p style={{ margin: 0, fontSize: 13, color: "var(--ms-warn)" }}>{view("expired")}</p>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              marginBottom: 12,
              flexWrap: "wrap",
            }}
          >
            <span className="ms-chip">{view("expires", { time: formatMmSs(left) })}</span>
            <span className="ms-chip">{t("redrawn")}</span>
            <span className="ms-chip">{view("recipientsHidden")}</span>
            <span className="ms-chip">{view("noExport")}</span>
            {data.redactions > 0 ? (
              <span className="ms-chip">{view("redactions", { count: data.redactions })}</span>
            ) : null}
          </div>

          <div className="ms-microlabel" style={LABEL}>
            {t("why")}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
              marginBottom: 14,
              fontSize: 13,
            }}
          >
            {data.why ? (
              <>
                <span className="ms-dot" style={{ background: WHY_DOT[data.why] }} />
                {waiting(`why.${data.why}`)}
              </>
            ) : (
              common("none")
            )}
            {data.issues.length > 0 ? (
              <span style={{ color: "var(--ms-muted)" }}>
                · {data.issues.map((issue) => t(`issues.${issue}`)).join(" · ")}
              </span>
            ) : null}
          </div>

          <div className="ms-microlabel" style={LABEL}>
            {t("text")}
          </div>
          {data.text.length === 0 ? (
            <p style={NOTE}>{t("noText")}</p>
          ) : (
            <div className="ms-revealed" style={{ marginBottom: 14 }}>
              {data.text.map((entry, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed order, position is identity
                <div key={i} style={{ marginTop: i === 0 ? 0 : 10 }}>
                  <div style={{ color: "var(--ms-muted)" }}>
                    <RevealText spans={entry.source} />
                  </div>
                  <RevealText spans={entry.spans} />
                </div>
              ))}
            </div>
          )}

          <div className="ms-microlabel" style={LABEL}>
            {t("links")}
          </div>
          {data.links.length === 0 ? (
            <p style={NOTE}>{t("noLinks")}</p>
          ) : (
            <div style={{ marginBottom: 14 }}>
              <Table>
                <thead>
                  <tr>
                    <th>{t("cols.source")}</th>
                    <th>{t("cols.link")}</th>
                    <th className="right">{t("cols.registered")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.links.map((link, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: fixed order, position is identity
                    <tr key={i}>
                      <td>{t(`sources.${SOURCE_KEYS[link.source]}`)}</td>
                      <td className="ms-mono ms-cell-wrap">
                        <RevealText spans={link.link} />
                      </td>
                      <td className="right" style={{ color: "var(--ms-muted)" }}>
                        {link.registeredAt ? (
                          <RelativeTime date={link.registeredAt} />
                        ) : (
                          common("none")
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}

          <div className="ms-microlabel" style={LABEL}>
            {t("files")}
          </div>
          {data.files.length === 0 ? (
            <p style={NOTE}>{t("noFiles")}</p>
          ) : (
            <div style={{ marginBottom: 14 }}>
              <Table>
                <thead>
                  <tr>
                    <th>{t("cols.name")}</th>
                    <th>{t("cols.kind")}</th>
                    <th>{t("cols.flags")}</th>
                    <th className="right">{t("cols.size")}</th>
                    <th className="right">{t("cols.pages")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.files.map((file, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: fixed order, position is identity
                    <tr key={i}>
                      <td className="ms-mono ms-cell-wrap">
                        <RevealText spans={file.name} />
                      </td>
                      <td className="ms-mono">{file.kind}</td>
                      <td>
                        {file.flags.length > 0
                          ? file.flags.map((flag) => t(`flags.${flag}`)).join(", ")
                          : common("none")}
                      </td>
                      <td className="right num">{formatBytes(file.size)}</td>
                      <td className="right num">
                        {file.pages === null ? common("none") : nf.format(file.pages)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}

          <div className="ms-microlabel" style={LABEL}>
            {t("previews")}
          </div>
          {data.previews.length === 0 ? (
            <p style={NOTE}>{t("noPreviews")}</p>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
                gap: 12,
              }}
            >
              {data.previews.map((preview, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed order, position is identity
                <figure key={i} style={{ margin: 0 }}>
                  {/* biome-ignore lint/performance/noImgElement: an inline data: JPEG the server already sized, nothing for next/image to optimize */}
                  <img
                    src={preview.src}
                    alt={preview.label.map((span) => span.text).join("")}
                    style={PREVIEW}
                  />
                  <figcaption
                    style={{
                      marginTop: 4,
                      fontSize: 12,
                      color: "var(--ms-muted)",
                      overflowWrap: "anywhere",
                    }}
                  >
                    <RevealText spans={preview.label} />
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </>
      )}
      <p style={{ margin: "12px 0 0", fontSize: 12.5, color: "var(--ms-muted)" }}>{view("note")}</p>
      <ModalFooter>
        <button type="button" className="ms-btn ms-btn-secondary" onClick={onClose}>
          {view("close")} <span className="ms-keycap">Esc</span>
        </button>
        {data && !expired && data.releasable && data.sameMedia > 0 ? (
          <button
            type="button"
            className="ms-btn ms-btn-primary"
            disabled={release.isPending}
            onClick={() => releaseSame(data.asOf)}
          >
            <BtnSpinner on={release.isPending} />
            {t("releaseSame", { count: data.sameMedia })}
          </button>
        ) : null}
      </ModalFooter>
    </Modal>
  );
}
