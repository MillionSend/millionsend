"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { CopyChip } from "@/components/copy-chip";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { toast } from "@/components/toast";
import { useTRPC } from "@/lib/trpc";
import type { ServedRegion } from "../region-actions";
import { useRegionFormats } from "./formatters";

const SERVICE_QUOTAS_URL =
  "https://console.aws.amazon.com/servicequotas/home/services/ses/quotas/L-804C8AE8";

const lead: React.CSSProperties = {
  margin: "10px 0 14px",
  color: "var(--ms-muted)",
  fontSize: 13.5,
  lineHeight: 1.6,
};
const danger: React.CSSProperties = {
  margin: "8px 0 0",
  color: "var(--ms-danger)",
  fontSize: "var(--ms-fs-label)",
};
/** The mock's pre.code block: inset ground, hairline, 12px mono. */
export const codeBlock: React.CSSProperties = {
  margin: 0,
  background: "var(--ms-inset)",
  border: "1px solid var(--ms-line)",
  borderRadius: "var(--ms-r-input)",
  padding: "10px 12px",
  fontSize: 12,
  lineHeight: 1.6,
  color: "var(--ms-bone)",
  overflowX: "auto",
  whiteSpace: "pre-wrap",
};

function CancelButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" className="ms-btn ms-btn-secondary" onClick={onClick}>
      {label} <span className="ms-keycap">Esc</span>
    </button>
  );
}

export function QuotaDialog({
  region,
  open,
  onClose,
}: {
  region: ServedRegion;
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("console.region");
  const common = useTranslations("console.common");
  const trpc = useTRPC();
  const f = useRegionFormats();
  const max = region.account?.quota.max24h ?? 0;
  const [desired, setDesired] = useState(String(Math.max(1, max * 10)));
  const [justification, setJustification] = useState<string | null>(null);
  const [denied, setDenied] = useState<{ text: string } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const facts = useQuery({
    ...trpc.console.regions.accessRequestFacts.queryOptions({ region: region.region }),
    enabled: open,
  });
  const sentPerDay = useQuery({
    ...trpc.console.overview.sentPerDay.queryOptions({ period: "7d" }),
    enabled: open,
  });
  const peak = facts.data?.peak30d ?? 0;
  const committed = sentPerDay.data?.committedPerDay ?? peak;
  const defaultJustification = facts.data
    ? t("quotaDialog.justificationDefault", { committed: f.n(committed), peak: f.n(peak) })
    : "";
  const justificationValue = justification ?? defaultJustification;
  const desiredNumber = Number.parseInt(desired, 10);
  const valid = Number.isInteger(desiredNumber) && desiredNumber >= 1;

  const request = useMutation(
    trpc.console.regions.requestQuota.mutationOptions({
      onSuccess: (result, input) => {
        if (result.ok) {
          toast(
            result.status
              ? t("toast.quotaFiled", { status: result.status })
              : t("toast.quotaFiledNoStatus"),
          );
          onClose();
        } else if (result.kind === "access_denied") {
          setDenied({
            text: t("quotaDialog.requestText", {
              region: region.region,
              current: f.n(max),
              desired: f.n(input.desired),
              justification: input.justification ?? "",
            }),
          });
        } else setFailure(result.message);
      },
      onError: (error) => setFailure(error.message),
    }),
  );
  const submit = () => {
    if (!valid || request.isPending || denied) return;
    setFailure(null);
    request.mutate({
      region: region.region,
      desired: desiredNumber,
      justification: justificationValue,
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      onConfirm={submit}
      title={t("quotaDialog.title", { region: region.region })}
    >
      <p style={lead}>{t("quotaDialog.lead")}</p>
      {denied ? (
        <>
          <p style={{ ...lead, marginTop: 0 }}>{t("quotaDialog.denied")}</p>
          <pre className="ms-mono" style={codeBlock}>
            {denied.text}
          </pre>
          <div style={{ marginTop: 10 }}>
            <CopyChip value={denied.text} display={`L-804C8AE8 · ${region.region}`} />
          </div>
          <ModalFooter>
            <CancelButton onClick={onClose} label={common("close")} />
            <a
              className="ms-btn ms-btn-secondary"
              href={SERVICE_QUOTAS_URL}
              target="_blank"
              rel="noreferrer"
            >
              {t("quotaDialog.openConsole")} ↗
            </a>
          </ModalFooter>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="ms-field">
            <label htmlFor="quota-desired">{t("quotaDialog.desired")}</label>
            <input
              id="quota-desired"
              type="number"
              min={1}
              step={1}
              className="ms-input mono"
              style={{ width: "100%" }}
              value={desired}
              disabled={request.isPending}
              onChange={(e) => setDesired(e.target.value)}
            />
            <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ms-muted)" }}>
              {t("quotaDialog.hint", { current: f.n(max), sent: f.n(region.sent24h) })}
            </p>
          </div>
          <div className="ms-field" style={{ marginTop: 14 }}>
            <label htmlFor="quota-why">{t("quotaDialog.justification")}</label>
            {facts.isPending ? (
              <Skeleton width="100%" height={72} radius="var(--ms-r-input)" />
            ) : (
              <textarea
                id="quota-why"
                className="ms-input"
                rows={3}
                style={{ width: "100%", resize: "vertical" }}
                value={justificationValue}
                disabled={request.isPending}
                onChange={(e) => setJustification(e.target.value)}
              />
            )}
          </div>
          {failure ? <p style={danger}>{t("quotaDialog.failed", { message: failure })}</p> : null}
          <ModalFooter>
            <CancelButton onClick={onClose} label={common("cancel")} />
            <button
              type="submit"
              className="ms-btn ms-btn-primary"
              disabled={!valid || request.isPending}
            >
              <BtnSpinner on={request.isPending} />
              {t("quotaDialog.file")} <ConfirmKeycap />
            </button>
          </ModalFooter>
        </form>
      )}
    </Modal>
  );
}

export function TemplateDialog({
  region,
  open,
  onClose,
}: {
  region: string;
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("console.region");
  const common = useTranslations("console.common");
  const trpc = useTRPC();
  const f = useRegionFormats();
  const facts = useQuery({
    ...trpc.console.regions.accessRequestFacts.queryOptions({ region }),
    enabled: open,
  });
  const text = facts.data
    ? t("templateDialog.text", {
        teams: f.n(facts.data.teams),
        sent24h: f.n(facts.data.sent24h),
        region,
        peak30d: f.n(facts.data.peak30d),
        bounceRate: f.pct2(facts.data.hardBounceRate7d),
        complaintRate: f.pct2(facts.data.complaintRate7d),
        domainsWithDmarc: f.n(facts.data.domainsWithDmarc),
        domains: f.n(facts.data.domainsVerified),
      })
    : null;
  const copy = async () => {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    toast(t("toast.copied"));
  };
  return (
    <Modal open={open} onClose={onClose} onConfirm={copy} title={t("templateDialog.title")}>
      <p style={lead}>{t("templateDialog.lead", { region })}</p>
      {text ? (
        <pre className="ms-mono" style={codeBlock}>
          {text}
        </pre>
      ) : facts.isError ? (
        <p style={danger}>{common("loadError")}</p>
      ) : (
        <Skeleton width="100%" height={150} radius="var(--ms-r-input)" />
      )}
      <ModalFooter>
        <CancelButton onClick={onClose} label={common("close")} />
        <button type="button" className="ms-btn ms-btn-primary" disabled={!text} onClick={copy}>
          {common("copy")} <ConfirmKeycap />
        </button>
      </ModalFooter>
    </Modal>
  );
}

export function PauseDialog({
  region,
  open,
  onClose,
  onChanged,
}: {
  region: string;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations("console.region");
  const common = useTranslations("console.common");
  const trpc = useTRPC();
  const [reason, setReason] = useState("");
  const hold = useMutation(
    trpc.console.regions.hold.mutationOptions({
      onSuccess: () => {
        toast(t("toast.held", { region }));
        onChanged();
        onClose();
      },
    }),
  );
  const submit = () => {
    if (reason.trim() === "" || hold.isPending) return;
    hold.mutate({ region, reason: reason.trim() });
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      onConfirm={submit}
      title={t("pauseDialog.title", { region })}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p style={lead}>{t("pauseDialog.lead")}</p>
        <div className="ms-field">
          <label htmlFor="pause-region-reason">{t("pauseDialog.reason")}</label>
          <input
            id="pause-region-reason"
            type="text"
            className="ms-input"
            style={{ width: "100%" }}
            placeholder={t("pauseDialog.reasonPlaceholder")}
            value={reason}
            disabled={hold.isPending}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        {hold.isError ? <p style={danger}>{hold.error.message}</p> : null}
        <ModalFooter>
          <CancelButton onClick={onClose} label={common("cancel")} />
          <button
            type="submit"
            className="ms-btn ms-btn-destructive"
            disabled={reason.trim() === "" || hold.isPending}
          >
            <BtnSpinner on={hold.isPending} />
            {t("pauseDialog.confirm")} <ConfirmKeycap />
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

export function ResumeDialog({
  region,
  open,
  onClose,
  onChanged,
}: {
  region: string;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations("console.region");
  const common = useTranslations("console.common");
  const trpc = useTRPC();
  const release = useMutation(
    trpc.console.regions.release.mutationOptions({
      onSuccess: () => {
        toast(t("toast.released", { region }));
        onChanged();
        onClose();
      },
    }),
  );
  const submit = () => {
    if (!release.isPending) release.mutate({ region });
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      onConfirm={submit}
      title={t("resumeDialog.title", { region })}
    >
      <p style={lead}>{t("resumeDialog.lead")}</p>
      {release.isError ? <p style={danger}>{release.error.message}</p> : null}
      <ModalFooter>
        <CancelButton onClick={onClose} label={common("cancel")} />
        <button
          type="button"
          className="ms-btn ms-btn-primary"
          disabled={release.isPending}
          onClick={submit}
        >
          <BtnSpinner on={release.isPending} />
          {t("resumeDialog.confirm")} <ConfirmKeycap />
        </button>
      </ModalFooter>
    </Modal>
  );
}

export function StopDialog({
  region,
  open,
  onClose,
}: {
  region: string;
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("console.region");
  const common = useTranslations("console.common");
  return (
    <Modal open={open} onClose={onClose} title={t("stopDialog.title", { region })}>
      <p style={lead}>{t("stopDialog.lead")}</p>
      <p style={{ ...lead, marginTop: 0, color: "var(--ms-bone)" }}>
        {t("stopDialog.body", { region })}
      </p>
      <ModalFooter>
        <CancelButton onClick={onClose} label={common("close")} />
      </ModalFooter>
    </Modal>
  );
}
