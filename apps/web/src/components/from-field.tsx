"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { Select, type SelectOption } from "@/components/select";
import { composeFromAddress, type FromParts, splitFromAddress } from "@/lib/from-address";
import { useTRPC } from "@/lib/trpc";

const ADD_DOMAIN = "__add-domain__";

/**
 * Structured From control: display name + local part + a native selector over
 * the team's sending domains (with each domain's verification status and an
 * add-domain shortcut) instead of a free-typed "Ada <ada@yourdomain.com>".
 * The composed RFC mailbox string is emitted upward, so the draft/API contract
 * is unchanged — and the API still verifies the domain at send time.
 *
 * Uncontrolled after mount: the parts seed from `value` once and edits flow
 * up, so a partially-filled row (which composes to "") never wipes the boxes.
 */
export function FromField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations("broadcasts");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const router = useRouter();
  const domains = useQuery(trpc.domains.list.queryOptions());

  const [parts, setParts] = useState<FromParts>(() => splitFromAddress(value));

  function update(patch: Partial<FromParts>) {
    const next = { ...parts, ...patch };
    setParts(next);
    onChange(composeFromAddress(next));
  }

  // Default to the first verified domain (else the first) once the list loads,
  // so the selector never sits empty when the team has domains. Emits through
  // onChange like a user edit — otherwise the parent's `from` could disagree
  // with what the field displays once the local part is typed.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (parts.domain || !domains.data || domains.data.length === 0) return;
    const preferred = domains.data.find((d) => d.status === "verified") ?? domains.data[0];
    if (!preferred) return;
    const next = { ...parts, domain: preferred.name };
    setParts(next);
    onChangeRef.current(composeFromAddress(next));
  }, [domains.data, parts]);

  const options = useMemo<SelectOption[]>(() => {
    const rows = domains.data ?? [];
    // Verification status rides as a badge so it stays visible on the trigger
    // after selection, not only inside the open list.
    const TONE = { verified: "success", pending: "warn", failed: "danger" } as const;
    const opts: SelectOption[] = rows.map((d) => {
      const status = d.status === "temporary_failure" ? "pending" : d.status;
      return {
        value: d.name,
        label: d.name,
        badge: { label: common(`status.${status}`), tone: TONE[status] ?? "neutral" },
      };
    });
    // A draft may reference a domain the team no longer has — keep it pickable
    // so opening the draft doesn't silently rewrite the sender.
    if (parts.domain && !rows.some((d) => d.name === parts.domain)) {
      opts.unshift({ value: parts.domain, label: parts.domain });
    }
    opts.push({ value: ADD_DOMAIN, label: `+ ${t("composer.fromAddDomain")}` });
    return opts;
  }, [domains.data, parts.domain, common, t]);

  const noDomains = domains.isSuccess && (domains.data?.length ?? 0) === 0 && !parts.domain;

  return (
    <div className="ms-field">
      <label htmlFor={`${id}-name`}>{t("composer.fromLabel")}</label>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <input
          id={`${id}-name`}
          className="ms-input"
          style={{ flex: "1 1 84px", minWidth: 72 }}
          placeholder={t("composer.fromNamePlaceholder")}
          autoComplete="off"
          value={parts.name}
          onChange={(e) => update({ name: e.target.value })}
        />
        <input
          className="ms-input mono"
          style={{ flex: "1 1 76px", minWidth: 64 }}
          placeholder={t("composer.fromLocalPlaceholder")}
          aria-label={t("composer.fromLocalLabel")}
          autoComplete="off"
          spellCheck={false}
          value={parts.local}
          onChange={(e) => update({ local: e.target.value.trim() })}
        />
        <span className="ms-mono" style={{ color: "var(--ms-muted)" }} aria-hidden="true">
          @
        </span>
        {noDomains ? (
          <Link
            href="/domains/new"
            className="ms-btn ms-btn-secondary"
            style={{ flex: "0 0 auto" }}
          >
            {t("composer.fromAddDomain")}
          </Link>
        ) : (
          <div style={{ flex: "1 1 150px", minWidth: 140 }}>
            <Select
              width="100%"
              ariaLabel={t("composer.fromDomainLabel")}
              value={parts.domain}
              onChange={(next) => {
                if (next === ADD_DOMAIN) router.push("/domains/new");
                else update({ domain: next });
              }}
              options={options}
            />
          </div>
        )}
      </div>
    </div>
  );
}
