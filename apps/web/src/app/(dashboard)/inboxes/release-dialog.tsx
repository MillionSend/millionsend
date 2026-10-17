"use client";

import { CONTENT_HOLDS } from "@millionsend/core/release-rules";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { DotParts } from "@/components/dot-parts";
import { BotIcon, InboxIcon, RestoreIcon, WebhookIcon } from "@/components/icons/mail-icons";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { toast } from "@/components/toast";
import { capitalize } from "@/lib/format";
import { isReadOnly } from "@/lib/read-only";
import { statusGlow } from "@/lib/status-glow";
import { useTRPC } from "@/lib/trpc";
import {
  holdScore,
  type QuarantinePreview,
  type ReleaseResult,
  releaseErrorText,
  screenedBeforeHold,
  screeningReasonWords,
} from "./parts";

/** Who reads held mail once it is released: an agent, or people in the inbox. */
type Kind = "agent" | "human";

/** Held mail in an inbox, or a virus-held catch-all row, which belongs to no inbox. */
type ReleaseTarget = { inboxId: string; emailId: string } | { catchAllId: string };

interface DialogProps {
  kind: Kind;
  onClose: () => void;
  onChange: () => void;
}

/**
 * The one way held mail is released, on every screen: a quiet button opening
 * the release dialog. `onChange` refreshes whatever shows the mail, after a
 * release and after a refusal alike.
 */
export function ReleaseButton({
  kind,
  target,
  disabled = false,
  onChange,
}: {
  kind: Kind;
  target: ReleaseTarget;
  disabled?: boolean;
  onChange: () => void;
}) {
  const t = useTranslations("inboxes");
  const [open, setOpen] = useState(false);
  const dialog = { kind, onClose: () => setOpen(false), onChange };
  return (
    <>
      <button
        type="button"
        className="ms-btn ms-btn-secondary"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {t("release")}
      </button>
      {!open ? null : "catchAllId" in target ? (
        <CatchAllRelease id={target.catchAllId} {...dialog} />
      ) : (
        <InboxRelease inboxId={target.inboxId} emailId={target.emailId} {...dialog} />
      )}
    </>
  );
}

function InboxRelease({
  inboxId,
  emailId,
  ...props
}: DialogProps & { inboxId: string; emailId: string }) {
  const trpc = useTRPC();
  const preview = useHold(inboxId, emailId);
  const settle = useSettle(props);
  const release = useMutation(trpc.inboxes.quarantine.release.mutationOptions(settle));
  return (
    <ReleaseDialog
      {...props}
      preview={preview}
      pending={release.isPending}
      onRelease={(trustSender) => release.mutate({ inboxId, emailId, trustSender })}
    />
  );
}

function CatchAllRelease({ id, ...props }: DialogProps & { id: string }) {
  const trpc = useTRPC();
  const preview = useHold(null, id);
  const settle = useSettle(props);
  const release = useMutation(trpc.receiving.release.mutationOptions(settle));
  return (
    <ReleaseDialog
      {...props}
      preview={preview}
      pending={release.isPending}
      onRelease={() => release.mutate({ id })}
    />
  );
}

/**
 * The hold as the dialog shows it; inboxId null for a catch-all row. Nothing
 * outlives the closed dialog: screening on release may have held the mail
 * again for another reason, which the next opening must gate on.
 */
function useHold(inboxId: string | null, emailId: string) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.inboxes.quarantine.preview.queryOptions({ inboxId, emailId }),
    gcTime: 0,
  });
}

/**
 * A release's answer in words. The callbacks sit on the mutation itself, so
 * the toast and the refresh still come when Esc closed the dialog mid-request.
 */
function useSettle({ kind, onClose, onChange }: DialogProps) {
  const t = useTranslations("inboxes");
  return {
    onSuccess: (result: ReleaseResult) => {
      if (result.outcome === "held_again") {
        toast(
          t("quarantine.heldAgain", {
            reason: t(`qr.${result.reason}`),
            score: holdScore(result) ?? "–",
          }),
          "warn",
        );
      } else {
        toast(t("quarantine.done", { kind }));
      }
      onClose();
      onChange();
    },
    // A refusal may mean the mail is gone or someone else released it: the
    // screens behind catch up, and the dialog stays for another try.
    onError: (error: unknown) => {
      toast(releaseErrorText(t, error), "danger");
      onChange();
    },
  };
}

function ReleaseDialog({
  kind,
  preview,
  pending,
  onClose,
  onRelease,
}: {
  kind: Kind;
  preview: { data?: QuarantinePreview | undefined; isError: boolean };
  pending: boolean;
  onClose: () => void;
  onRelease: (trustSender: boolean) => void;
}) {
  const t = useTranslations("inboxes");
  const [read, setRead] = useState(false);
  const [trust, setTrust] = useState(false);
  const hold = preview.data;
  const ready = hold !== undefined && !pending && (read || !CONTENT_HOLDS.includes(hold.reason));
  const release = () => {
    if (!hold || !ready) return;
    onRelease(trust && hold.trustOffered);
  };
  return (
    <Modal
      open
      onClose={onClose}
      onConfirm={release}
      size="wide"
      title={t("quarantine.title", { kind })}
    >
      {hold ? (
        <HoldDetails
          kind={kind}
          hold={hold}
          read={read}
          onRead={setRead}
          trust={trust}
          onTrust={setTrust}
        />
      ) : preview.isError ? (
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--ms-danger)" }}>
          {t("detail.error")}
        </p>
      ) : (
        <div style={{ display: "grid", gap: 8, margin: "6px 0 0" }}>
          <Skeleton width="45%" height={14} />
          <Skeleton width="70%" />
          <div className="ms-release-cols" style={{ marginTop: 14 }}>
            <Skeleton width="100%" height={220} radius={12} />
            <Skeleton width="100%" height={220} radius="var(--ms-r-input)" />
          </div>
        </div>
      )}
      <ModalFooter>
        {/* Mid-release, keeping it is no longer on offer; Esc still closes. */}
        <button
          type="button"
          className="ms-btn ms-btn-secondary"
          disabled={pending}
          onClick={onClose}
        >
          {t("quarantine.keep")} <span className="ms-keycap">Esc</span>
        </button>
        <button
          type="button"
          className="ms-btn ms-btn-destructive"
          disabled={!ready}
          onClick={release}
        >
          <BtnSpinner on={pending} />
          {t("quarantine.confirm", { kind })} <ConfirmKeycap />
        </button>
      </ModalFooter>
    </Modal>
  );
}

const mono = (chunks: React.ReactNode) => <span className="ms-mono">{chunks}</span>;

/** Why the mail was held and what releasing it does, beside the text a reader decides on. */
function HoldDetails({
  kind,
  hold,
  read,
  onRead,
  trust,
  onTrust,
}: {
  kind: Kind;
  hold: QuarantinePreview;
  read: boolean;
  onRead: (read: boolean) => void;
  trust: boolean;
  onTrust: (trust: boolean) => void;
}) {
  const t = useTranslations("inboxes");
  const te = useTranslations("emails");
  // Red where the content or a forged sender is the risk; amber where only the sender is unknown.
  const contentHold = CONTENT_HOLDS.includes(hold.reason);
  const tone = contentHold ? "danger" : "warn";
  const score = holdScore(hold);
  const flagged = [
    ...screeningReasonWords(t, hold.reasons),
    ...(hold.hiddenTextRemoved ? [t("quarantine.hiddenText")] : []),
  ];
  const otherScores = (["injection", "phishing"] as const).flatMap((key) => {
    const value = key === "injection" ? hold.injectionScore : hold.phishingScore;
    return value === null || key === hold.reason
      ? []
      : [t("quarantine.score", { label: capitalize(t(`qr.${key}`)), score: value })];
  });
  const { replyWithoutApproval, webhooks, forwards } = hold.releaseEffects;
  const channels = webhooks ? (forwards ? "both" : "webhooks") : forwards ? "forwards" : null;
  const effects = [
    kind === "human"
      ? { icon: <InboxIcon strokeWidth={1.6} />, text: t("quarantine.effects.human") }
      : {
          icon: <BotIcon strokeWidth={1.6} />,
          text: t(
            replyWithoutApproval ? "quarantine.effects.agentReply" : "quarantine.effects.agent",
          ),
        },
    ...(channels
      ? [
          {
            icon: <WebhookIcon strokeWidth={1.6} />,
            text: t("quarantine.effects.channels", { channels }),
          },
        ]
      : []),
    {
      icon: <RestoreIcon strokeWidth={1.6} />,
      text: t(
        hold.rescreenOnRelease
          ? "quarantine.effects.rescreen"
          : screenedBeforeHold(hold.reason)
            ? "quarantine.effects.notAgain"
            : "quarantine.effects.skips",
      ),
    },
  ];
  const trustLines = [
    t("quarantine.trustInbound", { kind }),
    ...(hold.trustEffects.sendWithoutApproval ? [t("quarantine.trustSend")] : []),
    ...(hold.trustEffects.codesExempt ? [t("quarantine.trustCodes")] : []),
  ];
  const gate = contentHold ? (
    <CheckCard checked={read} onChange={onRead} label={t("quarantine.ack", { kind })} />
  ) : hold.trustOffered ? (
    <CheckCard
      checked={trust}
      onChange={onTrust}
      label={t.rich("quarantine.trust", { address: hold.from, mono })}
    >
      {t("quarantine.trustLead")}
      <ul style={{ margin: "4px 0 0", paddingLeft: 16, display: "grid", gap: 3 }}>
        {trustLines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </CheckCard>
  ) : hold.trustNeedsAdmin ? (
    <p style={{ margin: 0, fontSize: 12.5, color: "var(--ms-muted)" }}>
      {t("quarantine.trustAdmins")}
    </p>
  ) : null;

  return (
    <>
      <p
        style={{ margin: "6px 0 18px", color: "var(--ms-muted)", fontSize: 13.5, lineHeight: 1.5 }}
      >
        <span style={{ color: "var(--ms-bone)", fontWeight: 600 }}>
          {t("quarantine.subject", { subject: hold.subject ?? t("noSubject") })}
        </span>
        <br />
        {t.rich("quarantine.fromTo", { from: hold.from, inbox: hold.inboxAddress, mono })}
      </p>
      <div className="ms-release-cols">
        <div>
          <div className="ms-microlabel" style={{ marginBottom: 6 }}>
            {t("quarantine.why")}
          </div>
          <div
            style={{
              border: `1px solid var(--ms-${tone}-border)`,
              borderRadius: 12,
              padding: "12px 14px",
              backgroundColor: "var(--ms-ground)",
              backgroundImage: statusGlow(tone),
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 600, color: `var(--ms-${tone})` }}>
                {capitalize(t(`qr.${hold.reason}`))}
              </span>
              {score === null ? null : (
                <span
                  className="ms-mono"
                  style={{ fontSize: 12.5, color: `var(--ms-${tone})`, whiteSpace: "nowrap" }}
                >
                  {t("quarantine.risk", { score })}
                </span>
              )}
            </div>
            {hold.reason === "not_allowlisted" ? (
              <p
                style={{
                  margin: "4px 0 0",
                  fontSize: 13,
                  lineHeight: 1.5,
                  color: "var(--ms-bone)",
                }}
              >
                {t("quarantine.notAllowlisted")}
              </p>
            ) : null}
            {hold.virusSignature ? (
              <p
                className="ms-mono"
                style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--ms-bone)" }}
              >
                {hold.virusSignature}
              </p>
            ) : null}
            {flagged.length > 0 ? (
              <ul className="ms-checklist" style={{ marginTop: 8, color: "var(--ms-bone)" }}>
                {flagged.map((item) => (
                  <li key={item}>
                    <span className="ms-checklist-mark">
                      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                        <circle cx="7" cy="7" r="2.5" fill={`var(--ms-${tone})`} />
                      </svg>
                    </span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--ms-muted)" }}>
              <DotParts
                text={[
                  ...otherScores,
                  t("quarantine.sender", { trust: t(`trust.${hold.senderTrust}`) }),
                ].join(" · ")}
              />
            </p>
          </div>
          <div className="ms-microlabel" style={{ margin: "18px 0 8px" }}>
            {t("quarantine.ifReleased")}
          </div>
          <ul className="ms-checklist" style={{ color: "var(--ms-bone)" }}>
            {effects.map(({ icon, text }) => (
              <li key={text}>
                <span className="ms-checklist-mark" style={{ color: "var(--ms-muted)" }}>
                  {icon}
                </span>
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="ms-microlabel" style={{ marginBottom: 6 }}>
            {t("quarantine.text")}
          </div>
          <div className="ms-revealed">
            {hold.text || (
              <span style={{ color: "var(--ms-muted)" }}>
                {isReadOnly() ? te("detail.hiddenBySupportView") : t("quarantine.noText")}
              </span>
            )}
          </div>
          {hold.text && hold.textTruncated ? (
            <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ms-muted)" }}>
              {t("quarantine.textTruncated")}
            </p>
          ) : null}
        </div>
      </div>
      {gate ? <div style={{ marginTop: 18 }}>{gate}</div> : null}
    </>
  );
}

/**
 * A tick in a card that lifts once ticked, as a chosen radio card does. Only
 * its first line is the label: what follows explains it and selects as text.
 */
function CheckCard({
  checked,
  onChange,
  label,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div
      style={{
        borderRadius: "var(--ms-r-input)",
        border: `1px solid var(${checked ? "--ms-line-strong" : "--ms-line"})`,
        background: checked ? "var(--ms-panel-raised)" : "none",
      }}
    >
      <label
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          cursor: "pointer",
          padding: "10px 12px",
          fontSize: 13.5,
          lineHeight: 1.45,
          color: "var(--ms-bone)",
        }}
      >
        <input
          type="checkbox"
          className="ms-checkbox"
          style={{ marginTop: 2 }}
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span style={{ minWidth: 0 }}>{label}</span>
      </label>
      {children ? (
        <div
          style={{
            margin: "-4px 0 0",
            padding: "0 12px 10px 37px",
            fontSize: 12.5,
            lineHeight: 1.5,
            color: "var(--ms-muted)",
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
