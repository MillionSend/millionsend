"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { CopyChip } from "@/components/copy-chip";
import { EmptyState } from "@/components/empty-state";
import { PlusGlyph } from "@/components/icons/nav-icons";
import { Modal } from "@/components/modal";
import { PageHeader } from "@/components/page-header";
import { PopoverMenu } from "@/components/popover-menu";
import { RelativeTime } from "@/components/relative-time";
import { Select } from "@/components/select";
import { Table } from "@/components/table";
import { maskApiKey } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";

export function ApiKeysView() {
  const t = useTranslations("api-keys");
  const common = useTranslations("common");
  const nav = useTranslations("nav");
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const listQuery = useQuery(trpc.apiKeys.list.queryOptions());
  const keys = listQuery.data;

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"live" | "test">("live");
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

  function closeCreate() {
    setCreateOpen(false);
    setRevealedToken(null);
    setName("");
    setMode("live");
    createMutation.reset();
  }

  return (
    <>
      <PageHeader
        title={nav("apiKeys")}
        actions={
          <button
            type="button"
            className="ms-btn ms-btn-primary"
            onClick={() => setCreateOpen(true)}
          >
            <PlusGlyph size={14} />
            {t("createKey")}
          </button>
        }
      />

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
                <td>{key.name}</td>
                <td>
                  <span className="ms-mono">{maskApiKey(key.tokenPrefix, key.last4)}</span>
                </td>
                <td>{key.lastUsedAt ? <RelativeTime date={key.lastUsedAt} /> : t("neverUsed")}</td>
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
      ) : null}

      <Modal
        open={createOpen}
        onClose={closeCreate}
        title={revealedToken ? t("reveal.title") : t("create.title")}
      >
        {revealedToken ? (
          <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
            <CopyChip value={revealedToken} />
            <p style={{ margin: 0, color: "var(--ms-warn)", fontSize: "var(--ms-fs-label)" }}>
              {t("reveal.warning")}
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" className="ms-btn ms-btn-primary" onClick={closeCreate}>
                {t("reveal.done")}
              </button>
            </div>
          </div>
        ) : (
          <form
            style={{ display: "grid", gap: 14, marginTop: 12 }}
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim().length === 0 || createMutation.isPending) return;
              createMutation.mutate({ name, mode });
            }}
          >
            <div className="ms-field">
              <label htmlFor="api-key-name">{t("create.name")}</label>
              <input
                id="api-key-name"
                className="ms-input"
                style={{ width: "100%" }}
                value={name}
                placeholder={t("create.namePlaceholder")}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="ms-field">
              <label htmlFor="api-key-mode">{t("create.mode")}</label>
              <Select
                id="api-key-mode"
                width="100%"
                value={mode}
                onChange={(value) => setMode(value === "test" ? "test" : "live")}
                ariaLabel={t("create.mode")}
                options={[
                  { value: "live", label: t("create.modeLive") },
                  { value: "test", label: t("create.modeTest") },
                ]}
              />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button type="button" className="ms-btn ms-btn-secondary" onClick={closeCreate}>
                {common("cancel")} <span className="ms-keycap">Esc</span>
              </button>
              <button
                type="submit"
                className="ms-btn ms-btn-primary"
                disabled={name.trim().length === 0 || createMutation.isPending}
              >
                {t("create.submit")} <span className="ms-keycap">↵</span>
              </button>
            </div>
          </form>
        )}
      </Modal>

      <Modal
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        title={t("revokeConfirm.title")}
      >
        {revokeTarget ? (
          <form
            style={{ display: "grid", gap: 14, marginTop: 12 }}
            onSubmit={(event) => {
              event.preventDefault();
              if (revokeMutation.isPending) return;
              revokeMutation.mutate({ id: revokeTarget.id });
            }}
          >
            <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
              {t("revokeConfirm.body", { name: revokeTarget.name })}
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button
                type="button"
                className="ms-btn ms-btn-secondary"
                onClick={() => setRevokeTarget(null)}
              >
                {common("cancel")} <span className="ms-keycap">Esc</span>
              </button>
              <button
                type="submit"
                className="ms-btn ms-btn-destructive"
                disabled={revokeMutation.isPending}
              >
                {t("revokeConfirm.confirm")} <span className="ms-keycap">↵</span>
              </button>
            </div>
          </form>
        ) : null}
      </Modal>
    </>
  );
}
