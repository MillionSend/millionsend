"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { ResourceApiButton } from "@/components/api-sheet";
import { CopyChip } from "@/components/copy-chip";
import { EmptyState } from "@/components/empty-state";
import { ExportCsvLink } from "@/components/export-csv-link";
import { PlusGlyph } from "@/components/icons/nav-icons";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { PageHeader } from "@/components/page-header";
import { PopoverMenu } from "@/components/popover-menu";
import { RelativeTime } from "@/components/relative-time";
import { Select } from "@/components/select";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { Table } from "@/components/table";
import { Tooltip } from "@/components/tooltip";
import { maskApiKey } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";
import { useTeamRole } from "@/lib/use-team-role";
import { ListFooter } from "../emails/list-parts";

/** Mirrors the loaded table: name, masked mono token, two relative times, menu column. */
function KeysSkeleton() {
  const t = useTranslations("api-keys");
  return (
    <Table>
      <thead>
        <tr>
          <th>{t("table.name")}</th>
          <th>{t("table.token")}</th>
          <th>{t("table.lastUsed")}</th>
          <th>{t("table.created")}</th>
          <th className="right" aria-label={t("table.menu")} />
        </tr>
      </thead>
      <tbody>
        {[110, 80].map((width) => (
          <tr key={width}>
            <td>
              <Skeleton width={width} height={13} />
            </td>
            <td>
              <Skeleton width={176} height={13} />
            </td>
            <td>
              <Skeleton width={72} />
            </td>
            <td>
              <Skeleton width={72} />
            </td>
            <td className="right">
              {/* Loaded rows hold PopoverMenu's 28px bare trigger here — the
                  row's tallest cell content, so the stand-in keeps 28px. */}
              <Skeleton width={28} height={28} radius={8} />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function ApiKeysView() {
  const t = useTranslations("api-keys");
  const common = useTranslations("common");
  const nav = useTranslations("nav");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const role = useTeamRole();
  const canExport = role === "owner" || role === "admin";

  const listQuery = useQuery(trpc.apiKeys.list.queryOptions());
  const keys = listQuery.data;

  const domainsQuery = useQuery(trpc.domains.list.queryOptions());
  const verifiedDomains = (domainsQuery.data ?? []).filter((d) => d.status === "verified");

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [permission, setPermission] = useState<"full_access" | "sending_access">("full_access");
  // "" = any verified domain; otherwise a domain id the key is scoped to.
  const [domainId, setDomainId] = useState("");
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);

  const invalidateList = () =>
    queryClient.invalidateQueries({ queryKey: trpc.apiKeys.list.queryKey() });

  const createMutation = useMutation(
    trpc.apiKeys.create.mutationOptions({
      onSuccess: (data) => {
        setRevealedToken(data.token);
        invalidateList();
      },
    }),
  );
  const revokeMutation = useMutation(
    trpc.apiKeys.revoke.mutationOptions({
      onSuccess: () => {
        setRevokeTarget(null);
        invalidateList();
      },
    }),
  );

  // Stable identities: Modal's focus effect depends on onClose, and a fresh
  // arrow per render would re-run it on every keystroke, stealing focus from
  // the form inputs.
  const { reset: resetCreate } = createMutation;
  const closeCreate = useCallback(() => {
    setCreateOpen(false);
    setRevealedToken(null);
    setName("");
    setPermission("full_access");
    setDomainId("");
    resetCreate();
  }, [resetCreate]);
  const closeRevoke = useCallback(() => setRevokeTarget(null), []);

  // Shared by the form submit and Modal's ⌘↵ onConfirm — one guard for both.
  const confirmCreate = () => {
    if (revealedToken) {
      closeCreate();
      return;
    }
    if (name.trim().length === 0 || createMutation.isPending) return;
    createMutation.mutate({ name, permission, domainId: domainId || null });
  };
  const confirmRevoke = () => {
    if (!revokeTarget || revokeMutation.isPending) return;
    revokeMutation.mutate({ id: revokeTarget.id });
  };
  const createError = createMutation.error;

  return (
    <>
      <PageHeader
        title={nav("apiKeys")}
        actions={
          <>
            {canExport ? <ExportCsvLink href="/export/api-keys" /> : null}
            <button
              type="button"
              className="ms-btn ms-btn-primary"
              onClick={() => setCreateOpen(true)}
            >
              <PlusGlyph size={14} />
              {t("createKey")}
            </button>
            <ResourceApiButton resource="apiKeys" />
          </>
        }
      />

      {listQuery.isPending ? <KeysSkeleton /> : null}

      {keys && keys.length === 0 ? (
        <EmptyState
          area="api-keys"
          headline={t("empty.headline")}
          body={t("empty.body")}
          cta={
            <button
              type="button"
              className="ms-btn ms-btn-primary"
              onClick={() => setCreateOpen(true)}
            >
              <PlusGlyph />
              {t("createKey")}
            </button>
          }
        />
      ) : null}

      {keys && keys.length > 0 ? (
        <>
          <Table>
            <thead>
              <tr>
                <th>{t("table.name")}</th>
                <th>{t("table.token")}</th>
                <th>{t("table.lastUsed")}</th>
                <th>{t("table.created")}</th>
                <th className="right" aria-label={t("table.menu")} />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td>
                    <span
                      style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
                    >
                      {key.name}
                      <span
                        className={`ms-badge ms-badge-${
                          key.permission === "sending_access" ? "info" : "neutral"
                        }`}
                      >
                        {t(key.permission === "sending_access" ? "scope.sending" : "scope.full")}
                      </span>
                      {key.domainName ? (
                        <span className="ms-badge ms-badge-neutral">{key.domainName}</span>
                      ) : null}
                    </span>
                  </td>
                  <td>
                    <span className="ms-mono">{maskApiKey(key.tokenPrefix, key.last4)}</span>
                  </td>
                  <td>
                    {key.lastUsedAt ? <RelativeTime date={key.lastUsedAt} /> : t("neverUsed")}
                  </td>
                  <td>
                    <RelativeTime date={key.createdAt} />
                  </td>
                  <td className="right">
                    <PopoverMenu
                      ariaLabel={t("table.menu")}
                      items={[
                        {
                          label: t("revoke"),
                          danger: true,
                          onSelect: () => setRevokeTarget({ id: key.id, name: key.name }),
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          <ListFooter left={t("pageOf", { pages: 1, total: keys.length })} singlePage />
        </>
      ) : null}

      <Modal
        open={createOpen}
        onClose={closeCreate}
        onConfirm={confirmCreate}
        title={revealedToken ? t("reveal.title") : t("create.title")}
      >
        {revealedToken ? (
          <form
            style={{ display: "grid", gap: 12, marginTop: 12 }}
            onSubmit={(event) => {
              event.preventDefault();
              confirmCreate();
            }}
          >
            {/* Grid children stretch; the chip should hug the token. */}
            <div style={{ justifySelf: "start", maxWidth: "100%" }}>
              <CopyChip value={revealedToken} />
            </div>
            <p style={{ margin: 0, color: "var(--ms-warn)", fontSize: "var(--ms-fs-label)" }}>
              {t("reveal.warning")}
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="submit" className="ms-btn ms-btn-primary">
                {t("reveal.done")} <ConfirmKeycap />
              </button>
            </div>
          </form>
        ) : (
          <form
            style={{ display: "grid", gap: 14, marginTop: 12 }}
            onSubmit={(event) => {
              event.preventDefault();
              confirmCreate();
            }}
          >
            <div className="ms-field">
              <label htmlFor="api-key-name">{t("create.name")}</label>
              <input
                id="api-key-name"
                className="ms-input"
                style={{ width: "100%" }}
                value={name}
                disabled={createMutation.isPending}
                placeholder={t("create.namePlaceholder")}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="ms-field">
              <div className="ms-label-row">
                <label htmlFor="api-key-permission">{t("create.permission")}</label>
                <Tooltip text={t("create.permissionTooltip")} />
              </div>
              <Select
                id="api-key-permission"
                width="100%"
                value={permission}
                disabled={createMutation.isPending}
                onChange={(value) =>
                  setPermission(value === "sending_access" ? "sending_access" : "full_access")
                }
                ariaLabel={t("create.permission")}
                options={[
                  { value: "full_access", label: t("create.permFull") },
                  { value: "sending_access", label: t("create.permSending") },
                ]}
              />
            </div>
            <div className="ms-field">
              <label htmlFor="api-key-domain">{t("create.domain")}</label>
              <Select
                id="api-key-domain"
                width="100%"
                value={domainId}
                disabled={createMutation.isPending}
                onChange={setDomainId}
                ariaLabel={t("create.domain")}
                options={[
                  { value: "", label: t("create.domainAny") },
                  ...verifiedDomains.map((d) => ({ value: d.id, label: d.name })),
                ]}
              />
            </div>
            {createError ? (
              <div
                className="ms-field-error"
                style={{
                  margin: 0,
                  display: "flex",
                  gap: 10,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                {createError.message}
              </div>
            ) : null}
            <ModalFooter>
              <button type="button" className="ms-btn ms-btn-secondary" onClick={closeCreate}>
                {common("cancel")} <span className="ms-keycap">Esc</span>
              </button>
              <button
                type="submit"
                className="ms-btn ms-btn-primary"
                disabled={name.trim().length === 0 || createMutation.isPending}
              >
                <BtnSpinner on={createMutation.isPending} />
                {t("create.submit")} <ConfirmKeycap />
              </button>
            </ModalFooter>
          </form>
        )}
      </Modal>

      <Modal
        open={revokeTarget !== null}
        onClose={closeRevoke}
        onConfirm={confirmRevoke}
        title={t("revokeConfirm.title")}
      >
        {revokeTarget ? (
          <form
            style={{ display: "grid", gap: 14, marginTop: 12 }}
            onSubmit={(event) => {
              event.preventDefault();
              confirmRevoke();
            }}
          >
            <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
              {t("revokeConfirm.body", { name: revokeTarget.name })}
            </p>
            <ModalFooter>
              <button type="button" className="ms-btn ms-btn-secondary" onClick={closeRevoke}>
                {common("cancel")} <span className="ms-keycap">Esc</span>
              </button>
              <button
                type="submit"
                className="ms-btn ms-btn-destructive"
                disabled={revokeMutation.isPending}
              >
                <BtnSpinner on={revokeMutation.isPending} />
                {t("revokeConfirm.confirm")} <ConfirmKeycap />
              </button>
            </ModalFooter>
          </form>
        ) : null}
      </Modal>
    </>
  );
}
