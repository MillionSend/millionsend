"use client";

import { INBOX_NAME_MAX, SHARED_USERNAME } from "@millionsend/core/inbox-username";
import type { InboxSafety } from "@millionsend/db/schema";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Select } from "@/components/select";
import { BtnSpinner } from "@/components/spinner";
import { WarnCard } from "@/components/warn-card";
import { useTRPC } from "@/lib/trpc";
import { trpcErrorCode } from "@/lib/trpc-error";
import { ACCEPT_FROM, acceptFromHint, acceptFromWarns, nameReviewError } from "./parts";

type Kind = "agent" | "human";
type AcceptFrom = InboxSafety["accept_from"];

const SHARED = "shared";
const EXPIRY = ["never", "1h", "24h", "7d", "30d"] as const;
// Lowercase ASCII, no leading, trailing or doubled dot (the API's own rule).
const LOCAL_PART_RE = /^(?!\.)(?!.*\.\.)[a-z0-9._%+-]{1,64}(?<!\.)$/;

/** A new inbox: an address, who reads it, whose mail it takes and how long it lives. */
export function CreateInboxDialog({
  open,
  onClose,
  domains,
  sharedDomain,
}: {
  open: boolean;
  onClose: () => void;
  domains: { id: string; name: string }[];
  sharedDomain: string | null;
}) {
  const t = useTranslations("inboxes");
  const common = useTranslations("common");
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const firstDomain = domains[0]?.id ?? (sharedDomain ? SHARED : "");
  const [domain, setDomain] = useState(firstDomain);
  const [localPart, setLocalPart] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("agent");
  const [acceptFrom, setAcceptFrom] = useState<AcceptFrom>("verified");
  const [expires, setExpires] = useState<(typeof EXPIRY)[number]>("never");
  const shared = domain === SHARED;

  const create = useMutation(
    trpc.inboxes.create.mutationOptions({
      onSuccess: (inbox) => {
        void queryClient.invalidateQueries(trpc.inboxes.pathFilter());
        router.push(`/inboxes/${inbox.id}`);
      },
    }),
  );
  const { reset } = create;
  const close = useCallback(() => {
    reset();
    setLocalPart("");
    setName("");
    onClose();
  }, [reset, onClose]);

  const local = localPart.trim().toLowerCase();
  // On the shared domain the address is optional: left empty, it is random.
  const localValid = shared
    ? local === "" || SHARED_USERNAME.test(local)
    : LOCAL_PART_RE.test(local);
  const domainName = shared ? sharedDomain : domains.find((d) => d.id === domain)?.name;
  const blocked = !domain || !localValid || create.isPending;
  const submit = () => {
    if (blocked) return;
    create.mutate({
      kind,
      acceptFrom,
      expiresIn: expires === "never" ? null : expires,
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(shared ? (local ? { localPart: local } : {}) : { domainId: domain, localPart: local }),
    });
  };

  const code = trpcErrorCode(create.error);
  const error = create.error
    ? code === "CONFLICT"
      ? t("create.errors.taken")
      : code === "PRECONDITION_FAILED"
        ? t("create.errors.notReceiving", { domain: domainName ?? "" })
        : code === "TOO_MANY_REQUESTS"
          ? t("create.errors.rate")
          : code === "FORBIDDEN"
            ? t("limit.full")
            : create.error.message
    : null;
  const review = nameReviewError(t, create.error);

  return (
    <Modal open={open} onClose={close} onConfirm={submit} title={t("create.title")}>
      <form
        style={{ display: "grid", gap: 14, marginTop: 12 }}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
          {t("empty.body")}
        </p>
        <div className="ms-field">
          <label htmlFor="inbox-local">{t("create.address")}</label>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              id="inbox-local"
              className="ms-input mono"
              style={{ flex: "1 1 160px", minWidth: 0 }}
              value={localPart}
              disabled={create.isPending}
              placeholder={shared ? t("create.random") : "orders-agent"}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setLocalPart(event.target.value)}
            />
            <Select
              value={domain}
              onChange={setDomain}
              width={260}
              disabled={create.isPending}
              ariaLabel={t("create.address")}
              options={[
                ...domains.map((d) => ({ value: d.id, label: `@${d.name}` })),
                ...(sharedDomain ? [{ value: SHARED, label: `@${sharedDomain}` }] : []),
              ]}
            />
          </div>
          <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ms-muted)" }}>
            {local && !localValid
              ? t(shared ? "create.errors.username" : "create.errors.localPart")
              : sharedDomain
                ? t("create.addressHint", { domain: sharedDomain })
                : t("create.addressHintOwn")}
          </p>
        </div>
        <div className="ms-field">
          <label htmlFor="inbox-name">{t("create.name")}</label>
          <input
            id="inbox-name"
            className="ms-input"
            style={{ width: "100%" }}
            value={name}
            maxLength={INBOX_NAME_MAX}
            disabled={create.isPending}
            placeholder={t("create.namePlaceholder")}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <fieldset className="ms-field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend>{t("create.kind")}</legend>
          <div style={{ display: "grid", gap: 6 }}>
            {(["agent", "human"] as const).map((value) => (
              <label key={value} className="ms-radio-card">
                <input
                  type="radio"
                  name="inbox-kind"
                  checked={kind === value}
                  disabled={create.isPending}
                  onChange={() => {
                    setKind(value);
                    // Each kind starts from its own default (core defaultSafety).
                    setAcceptFrom(value === "agent" ? "verified" : "anyone");
                  }}
                />
                <span>
                  {t(`create.${value}`)}
                  <div className="sub">{t(`create.${value}Hint`)}</div>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
          <div className="ms-field">
            <label htmlFor="inbox-accept">{t("acceptFrom.label")}</label>
            <Select
              id="inbox-accept"
              value={acceptFrom}
              onChange={(value) => setAcceptFrom(value as AcceptFrom)}
              width="100%"
              disabled={create.isPending}
              ariaLabel={t("acceptFrom.label")}
              options={ACCEPT_FROM.map((value) => ({ value, label: t(`acceptFrom.${value}`) }))}
            />
          </div>
          <div className="ms-field">
            <label htmlFor="inbox-expires">{t("expires.label")}</label>
            <Select
              id="inbox-expires"
              value={expires}
              onChange={(value) => setExpires(value as (typeof EXPIRY)[number])}
              width="100%"
              disabled={create.isPending}
              ariaLabel={t("expires.label")}
              options={EXPIRY.map((value) => ({ value, label: t(`expires.${value}`) }))}
            />
          </div>
        </div>
        {acceptFromWarns(kind, acceptFrom) ? (
          <WarnCard flush>{t("acceptFrom.anyoneWarn")}</WarnCard>
        ) : (
          // Pulled up to the selects it explains, as a field's own hint sits 6px under it.
          <p
            style={{ margin: "-8px 0 0", fontSize: 12, lineHeight: 1.5, color: "var(--ms-muted)" }}
          >
            {acceptFromHint(t, kind, shared, acceptFrom)}
          </p>
        )}
        {error ? (
          <div className="ms-field-error" style={{ margin: 0 }}>
            {review ? `${review} ${t("create.errors.orRandom")}` : error}
          </div>
        ) : null}
        <ModalFooter>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={close}>
            {common("cancel")} <span className="ms-keycap">Esc</span>
          </button>
          <button type="submit" className="ms-btn ms-btn-primary" disabled={blocked}>
            <BtnSpinner on={create.isPending} />
            {t("create.title")} <ConfirmKeycap />
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
