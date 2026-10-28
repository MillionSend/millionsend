"use client";

import { FROM_NAME_MAX, INBOX_NAME_MAX, SHARED_USERNAME } from "@millionsend/core/inbox-username";
import type { InboxSafety } from "@millionsend/db/schema";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Select } from "@/components/select";
import { BtnSpinner } from "@/components/spinner";
import { Tooltip } from "@/components/tooltip";
import { WarnCard } from "@/components/warn-card";
import { fromNameFromName, localPartFromName } from "@/lib/inbox-defaults";
import { useTRPC } from "@/lib/trpc";
import { trpcErrorCode } from "@/lib/trpc-error";
import { receivingSubdomain } from "@/lib/zone";
import { DOMAIN_TONE, type DomainStatus, useDomainStatusLabel } from "../domains/domain-status";
import { ACCEPT_FROM, acceptFromHint, acceptFromWarns, nameReviewError } from "./parts";
import { ReceivingCard } from "./receiving-card";

type Kind = "agent" | "human";
type AcceptFrom = InboxSafety["accept_from"];

const SHARED = "shared";
const EXPIRY = ["never", "1h", "24h", "7d", "30d"] as const;
// Lowercase ASCII, no leading, trailing or doubled dot (the API's own rule).
const LOCAL_PART_RE = /^(?!\.)(?!.*\.\.)[a-z0-9._%+-]{1,64}(?<!\.)$/;
const HINT = { margin: "6px 0 0", fontSize: 12, color: "var(--ms-muted)" } as const;

/** A new inbox: an address, who reads it, whose mail it takes and how long it lives. */
export function CreateInboxDialog({
  open,
  onClose,
  domains,
  otherDomains,
  sharedDomain,
}: {
  open: boolean;
  onClose: () => void;
  /** Verified and receiving: an inbox there gets mail. */
  domains: { id: string; name: string }[];
  /** The team's other domains, listed with what each still needs. */
  otherDomains: { id: string; name: string; status: DomainStatus }[];
  sharedDomain: string | null;
}) {
  const t = useTranslations("inboxes");
  const common = useTranslations("common");
  const statusLabel = useDomainStatusLabel();
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const firstDomain = domains[0]?.id ?? (sharedDomain ? SHARED : (otherDomains[0]?.id ?? ""));
  const [domain, setDomain] = useState(firstDomain);
  const [name, setName] = useState("");
  // The address and the sender name follow the name until typed in (then "" counts as typed).
  const [typedLocal, setTypedLocal] = useState<string | null>(null);
  const [typedSender, setTypedSender] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>("agent");
  const [acceptFrom, setAcceptFrom] = useState<AcceptFrom>("verified");
  const [expires, setExpires] = useState<(typeof EXPIRY)[number]>("never");
  const shared = domain === SHARED;
  const localPart = typedLocal ?? localPartFromName(name);
  const fromName = typedSender ?? fromNameFromName(name);

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
    setName("");
    setTypedLocal(null);
    setTypedSender(null);
    onClose();
  }, [reset, onClose]);

  const local = localPart.trim().toLowerCase();
  const sender = fromName.trim();
  // On the shared domain the address is optional: left empty, it is random.
  const localValid = shared
    ? local === "" || SHARED_USERNAME.test(local)
    : LOCAL_PART_RE.test(local);
  const localHint =
    local && !localValid
      ? t(shared ? "create.errors.username" : "create.errors.localPart")
      : local && typedLocal === null
        ? t(shared ? "create.addressFromName" : "create.addressFromNameOwn")
        : null;
  const receivingPick = domains.find((d) => d.id === domain);
  const otherPick = otherDomains.find((d) => d.id === domain);
  const ownPick = receivingPick
    ? { ...receivingPick, status: "verified" as const, receiving: true }
    : otherPick
      ? { ...otherPick, receiving: false }
      : null;
  const domainName = shared ? sharedDomain : ownPick?.name;
  // The server refuses a domain that doesn't receive; Create says why first,
  // in words true whether or not the domain's mail goes elsewhere.
  const notReady = otherPick
    ? t(
        otherPick.status === "verified" ? "create.receiving.offTitle" : "create.errors.notVerified",
        { domain: otherPick.name },
      )
    : null;
  const blocked = !domain || !localValid || create.isPending || notReady !== null;
  const submit = () => {
    if (blocked) return;
    create.mutate({
      kind,
      acceptFrom,
      expiresIn: expires === "never" ? null : expires,
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(sender ? { fromName: sender } : {}),
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
  const createButton = (
    <button type="submit" className="ms-btn ms-btn-primary" disabled={blocked}>
      <BtnSpinner on={create.isPending} />
      {t("create.title")} <ConfirmKeycap />
    </button>
  );

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
          <p style={HINT}>{t("create.nameHint")}</p>
        </div>
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
              onChange={(event) => setTypedLocal(event.target.value)}
            />
            <Select
              value={domain}
              onChange={setDomain}
              width="min(300px, 100%)"
              disabled={create.isPending}
              ariaLabel={t("create.domain")}
              options={[
                ...domains.map((d) => ({ value: d.id, label: `@${d.name}` })),
                ...(sharedDomain
                  ? [{ value: SHARED, label: `@${sharedDomain}`, hint: t("create.noDns") }]
                  : []),
                ...otherDomains.map((d) => ({
                  value: d.id,
                  label: `@${d.name}`,
                  badge:
                    d.status === "verified"
                      ? { label: t("create.receivingOff"), tone: "neutral" as const }
                      : { label: statusLabel(d.status), tone: DOMAIN_TONE[d.status] },
                })),
              ]}
            />
          </div>
          {localHint ? <p style={HINT}>{localHint}</p> : null}
          {/* The one pointer to the team's own domains: it stays while the name is typed. */}
          {shared && sharedDomain ? (
            <p style={{ ...HINT, marginTop: localHint ? 2 : 6 }}>
              {domains.length + otherDomains.length > 0
                ? t("create.addressHint", { domain: sharedDomain })
                : t.rich("create.addressHintNone", {
                    domain: sharedDomain,
                    link: (chunks) => (
                      <Link href="/domains" className="ms-link">
                        {chunks}
                      </Link>
                    ),
                  })}
            </p>
          ) : null}
          {ownPick ? (
            <ReceivingCard
              key={ownPick.id}
              domain={ownPick}
              sharedDomain={sharedDomain}
              subdomainTaken={[...domains, ...otherDomains].some(
                (d) => d.name === receivingSubdomain(ownPick.name),
              )}
            />
          ) : null}
        </div>
        <div className="ms-field">
          <label htmlFor="inbox-from-name">{t("edit.fromName")}</label>
          <input
            id="inbox-from-name"
            className="ms-input"
            style={{ width: "100%" }}
            value={fromName}
            maxLength={FROM_NAME_MAX}
            disabled={create.isPending}
            onChange={(event) => setTypedSender(event.target.value)}
          />
          <p style={HINT}>{t("create.fromNameHint")}</p>
          {local || shared ? (
            <p style={HINT}>
              {t.rich("create.preview", {
                named: sender ? "yes" : "no",
                sender,
                local: local || t("create.previewRandom"),
                domain: domainName ?? "",
                addr: (chunks) => <span className="ms-mono">{chunks}</span>,
              })}
            </p>
          ) : null}
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
            {review
              ? // A sender name goes to the same review, so a random address alone gets nothing past it.
                review.orRandom && !sender
                ? `${review.text} ${t("create.errors.orRandom")}`
                : review.text
              : error}
          </div>
        ) : null}
        <ModalFooter>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={close}>
            {common("cancel")} <span className="ms-keycap">Esc</span>
          </button>
          {notReady ? (
            <Tooltip inline text={notReady}>
              {createButton}
            </Tooltip>
          ) : (
            createButton
          )}
        </ModalFooter>
      </form>
    </Modal>
  );
}
