"use client";

import type { InboxSafety } from "@millionsend/db/schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ChipMultiSelect } from "@/components/chip-multi-select";
import { SectionCard } from "@/components/section-card";
import { Select } from "@/components/select";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { Switch } from "@/components/switch";
import { toast } from "@/components/toast";
import { Tooltip } from "@/components/tooltip";
import { WarnCard } from "@/components/warn-card";
import { typedAllowlistEntry, typedListAddress } from "@/lib/email-input";
import { sharedModeKey } from "@/lib/shared-mode";
import { useTRPC } from "@/lib/trpc";
import { useUnsavedChangesWarning } from "@/lib/use-unsaved-warning";
import { ACCEPT_FROM, acceptFromHint, acceptFromWarns, type InboxDetail } from "../parts";

const POLICIES = ["reply_only", "allowlist", "open"] as const;
const SHARED_HINT = {
  plan: "policy.sharedPlan",
  instance: "policy.sharedOnly",
  paused: "policy.sharedPaused",
} as const;

const hint: React.CSSProperties = { fontSize: 12, color: "var(--ms-muted)", lineHeight: 1.5 };

/** One switch row: the rule, what it does, and its switch at the right. */
function Rule({
  label,
  note,
  children,
}: {
  label: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16, marginBottom: 14 }}>
      <div style={{ minWidth: 0 }}>
        <span style={{ display: "block", fontSize: "var(--ms-fs-label)", color: "var(--ms-bone)" }}>
          {label}
        </span>
        <span style={hint}>{note}</span>
      </div>
      {children}
    </div>
  );
}

export function SafetyTab({ inbox, admin }: { inbox: InboxDetail; admin: boolean }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.inboxes.safety.queryOptions({ id: inbox.id }));
  if (!query.data) return <Skeleton width="60%" height={14} />;
  return (
    <SafetyForm
      inbox={inbox}
      admin={admin}
      stored={query.data.safety}
      memberEmails={query.data.memberEmails}
      retentionDays={query.data.retentionDays}
    />
  );
}

export function SafetyForm({
  inbox,
  admin,
  stored,
  memberEmails,
  retentionDays,
}: {
  inbox: InboxDetail;
  admin: boolean;
  stored: InboxSafety;
  memberEmails: string[];
  retentionDays: number;
}) {
  const t = useTranslations("inboxes");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  // Edits ride over the stored rules, so no refetch can reset them.
  const [draft, setDraft] = useState<InboxSafety | null>(null);
  const rules = draft ?? stored;
  const set = <K extends keyof InboxSafety>(key: K, value: InboxSafety[K]) =>
    setDraft((current) => ({ ...(current ?? stored), [key]: value }));
  const save = useMutation(
    trpc.inboxes.updateSafety.mutationOptions({
      onSuccess: async () => {
        toast(t("safety.saved"));
        // The saved rules land before the draft goes, so the old ones never flash back.
        await queryClient.invalidateQueries({
          queryKey: trpc.inboxes.safety.queryKey({ id: inbox.id }),
        });
        setDraft(null);
      },
    }),
  );
  const locked = !admin || inbox.expired || save.isPending;
  const agent = inbox.kind === "agent";
  const shared = inbox.shared ? "yes" : "no";
  const sharedMode = sharedModeKey(inbox);
  // On the shared domain the allowlist never vouches for a recipient, and open
  // needs the open mode; a stored choice stays listed so a downgraded inbox can step back.
  const policies = inbox.shared
    ? POLICIES.filter(
        (p) =>
          p === "reply_only" || p === stored.send_policy || (p === "open" && sharedMode === null),
      )
    : POLICIES;
  // The shared domain ignores owner addresses: it forwards to team members only.
  const forwardOptions = [
    ...new Set([...memberEmails, ...(inbox.shared ? [] : rules.owner_addresses)]),
  ].map((email) => ({ value: email, label: email }));
  const changed = draft !== null && JSON.stringify(draft) !== JSON.stringify(stored);
  useUnsavedChangesWarning(changed, common("unsavedWarn"));

  return (
    <form
      style={{ display: "grid", gap: 20, maxWidth: 760 }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!locked && changed) save.mutate({ id: inbox.id, patch: { ...rules } });
      }}
    >
      {admin ? null : <p style={{ ...hint, margin: 0, fontSize: 13 }}>{t("safety.adminOnly")}</p>}

      <SectionCard title={t("safety.whoCanWrite")}>
        <p style={{ ...hint, margin: "0 0 12px" }}>
          {t(agent ? "safety.whoCanWriteHint" : "safety.whoCanWriteHintHuman")}
        </p>
        <div
          role="radiogroup"
          aria-label={t("safety.whoCanWrite")}
          style={{ display: "grid", gap: 6 }}
        >
          {ACCEPT_FROM.map((value) => (
            <label key={value} className="ms-radio-card">
              <input
                type="radio"
                name="accept-from"
                checked={rules.accept_from === value}
                disabled={locked}
                onChange={() => set("accept_from", value)}
              />
              <span>
                {t(`acceptFrom.${value}`)}
                <div className="sub">{acceptFromHint(t, inbox.kind, inbox.shared, value)}</div>
              </span>
            </label>
          ))}
        </div>
        {acceptFromWarns(inbox.kind, rules.accept_from) ? (
          <WarnCard>{t("acceptFrom.anyoneWarn")}</WarnCard>
        ) : null}
        <div className="ms-field" style={{ marginTop: 14 }}>
          <label htmlFor="safety-allowlist">{t("safety.allowlist")}</label>
          <ChipMultiSelect
            id="safety-allowlist"
            value={rules.allowlist}
            onChange={(values) => set("allowlist", values)}
            options={[]}
            onCreate={typedAllowlistEntry}
            placeholder={t("safety.addSender")}
            ariaLabel={t("safety.allowlist")}
            removeLabel={(value) => t("safety.remove", { value })}
            disabled={locked}
          />
        </div>
      </SectionCard>

      <SectionCard title={t(agent ? "safety.beforeRead" : "safety.beforeReadHuman")}>
        {agent ? (
          <Rule label={t("safety.screening")} note={t("safety.screeningHint")}>
            <Switch
              checked={rules.screening}
              disabled={locked}
              onChange={(on) => set("screening", on)}
              ariaLabel={t("safety.screening")}
            />
          </Rule>
        ) : null}
        <Rule label={t("safety.hiddenText")} note={t("safety.hiddenTextHint")}>
          <Switch checked disabled onChange={() => {}} ariaLabel={t("safety.hiddenText")} />
        </Rule>
        <Rule
          label={t("safety.extractCodes")}
          note={t(agent ? "safety.extractCodesHint" : "safety.extractCodesHintHuman")}
        >
          <Switch
            checked={rules.extract_codes}
            disabled={locked}
            onChange={(on) => set("extract_codes", on)}
            ariaLabel={t("safety.extractCodes")}
          />
        </Rule>
      </SectionCard>

      <SectionCard title={t(agent ? "safety.maySend" : "safety.maySendHuman")}>
        {/* Send rules bind only an agent's own sends: a people inbox has just the daily cap. */}
        {agent ? (
          <>
            <div className="ms-field" style={{ marginBottom: 14 }}>
              <label htmlFor="safety-policy">{t("safety.sendPolicy")}</label>
              <Select
                id="safety-policy"
                value={rules.send_policy}
                onChange={(value) => {
                  const policy = POLICIES.find((p) => p === value);
                  if (policy) set("send_policy", policy);
                }}
                width="100%"
                disabled={locked || policies.length === 1}
                ariaLabel={t("safety.sendPolicy")}
                options={policies.map((p) => ({ value: p, label: t(`policy.${p}`) }))}
              />
              <p style={{ ...hint, margin: "6px 0 0" }}>
                {t(sharedMode ? SHARED_HINT[sharedMode] : "policy.reply_onlyHint")}
              </p>
            </div>
            <Rule label={t("safety.requireApproval")} note={t("safety.requireApprovalHint")}>
              <Switch
                checked={rules.require_approval}
                disabled={locked}
                onChange={(on) => set("require_approval", on)}
                ariaLabel={t("safety.requireApproval")}
              />
            </Rule>
            <Rule label={t("safety.privateCodes")} note={t("safety.privateCodesHint")}>
              <Switch
                checked={rules.private_codes}
                disabled={locked}
                onChange={(on) => set("private_codes", on)}
                ariaLabel={t("safety.privateCodes")}
              />
            </Rule>
          </>
        ) : null}
        <div className="ms-field">
          <label htmlFor="safety-cap">{t("safety.sendCap")}</label>
          <input
            id="safety-cap"
            type="number"
            className="ms-input"
            style={{ width: 160 }}
            min={1}
            max={inbox.shared ? 50 : 100_000}
            value={rules.send_cap ?? ""}
            placeholder={t("safety.sendCapNone")}
            disabled={locked}
            onChange={(event) =>
              set("send_cap", event.target.value === "" ? null : Number(event.target.value))
            }
          />
          {agent ? null : (
            <p style={{ ...hint, margin: "6px 0 0" }}>
              {t(inbox.shared ? "safety.sendCapHintHumanShared" : "safety.sendCapHintHuman")}
            </p>
          )}
        </div>
      </SectionCard>

      <SectionCard title={t("safety.forwarding")}>
        <div className="ms-field">
          <div className="ms-label-row">
            <label htmlFor="safety-forward">{t("safety.forwardTo")}</label>
            <Tooltip text={t("safety.forwardToTip", { shared })} />
          </div>
          <ChipMultiSelect
            id="safety-forward"
            value={rules.forward_to}
            onChange={(values) => set("forward_to", values)}
            options={forwardOptions}
            placeholder={t("safety.forwardPlaceholder", { shared })}
            ariaLabel={t("safety.forwardTo")}
            removeLabel={(value) => t("safety.remove", { value })}
            disabled={locked}
          />
        </div>
        {inbox.shared ? null : (
          <div className="ms-field" style={{ marginTop: 14 }}>
            <div className="ms-label-row">
              <label htmlFor="safety-owners">{t("safety.owners")}</label>
              <Tooltip text={t("safety.ownersTip", { kind: inbox.kind })} />
            </div>
            <ChipMultiSelect
              id="safety-owners"
              value={rules.owner_addresses}
              onChange={(values) => {
                set("owner_addresses", values);
                // A forward target that stops being an owner stops being allowed.
                const allowed = new Set([...memberEmails, ...values]);
                set(
                  "forward_to",
                  rules.forward_to.filter((target) => allowed.has(target)),
                );
              }}
              options={[]}
              onCreate={typedListAddress}
              placeholder={t("safety.addOwner")}
              ariaLabel={t("safety.owners")}
              removeLabel={(value) => t("safety.remove", { value })}
              disabled={locked}
            />
          </div>
        )}
      </SectionCard>

      {save.error ? (
        <div className="ms-field-error" style={{ margin: 0 }}>
          {save.error.message}
        </div>
      ) : null}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          alignItems: "flex-end",
          gap: 16,
        }}
      >
        <div style={{ display: "grid", gap: 6, maxWidth: 520 }}>
          {agent ? <p style={{ ...hint, margin: 0 }}>{t("safety.alwaysOn")}</p> : null}
          <p style={{ ...hint, margin: 0 }}>
            {t("safety.retentionValue", { days: retentionDays })}
          </p>
        </div>
        {admin ? (
          <button
            type="submit"
            className="ms-btn ms-btn-primary"
            style={{ marginLeft: "auto" }}
            disabled={locked || !changed}
          >
            <BtnSpinner on={save.isPending} />
            {t("safety.save")}
          </button>
        ) : null}
      </div>
    </form>
  );
}
