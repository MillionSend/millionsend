"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { LeadCell } from "@/components/lead-cell";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { PopoverMenu } from "@/components/popover-menu";
import { RelativeTime } from "@/components/relative-time";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { Table } from "@/components/table";
import { Tooltip } from "@/components/tooltip";
import { Truncated } from "@/components/truncated";
import { formatDate } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";

export function ConnectedAppsView() {
  const t = useTranslations("settings.connectedApps");
  const common = useTranslations("common");
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const listQuery = useQuery(trpc.connectedApps.list.queryOptions());
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);
  const revokeMutation = useMutation(
    trpc.connectedApps.revoke.mutationOptions({
      onSuccess: () => {
        setRevokeTarget(null);
        queryClient.invalidateQueries({ queryKey: trpc.connectedApps.list.queryKey() });
      },
    }),
  );
  // Stable identity: Modal's focus effect depends on onClose.
  const { reset: resetRevoke } = revokeMutation;
  const closeRevoke = useCallback(() => {
    setRevokeTarget(null);
    resetRevoke();
  }, [resetRevoke]);
  const confirmRevoke = () => {
    if (!revokeTarget || revokeMutation.isPending) return;
    revokeMutation.mutate({ id: revokeTarget.id });
  };
  const grants = listQuery.data;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 20 }}>
      <p style={{ margin: 0, fontSize: 13, color: "var(--ms-muted)", lineHeight: 1.55 }}>
        {t("intro")}
      </p>
      {listQuery.isPending ? <Skeleton width="100%" height={48} /> : null}
      {grants && grants.length === 0 ? (
        <p className="ms-card" style={{ margin: 0, padding: 24, color: "var(--ms-muted)" }}>
          {t("empty")}
        </p>
      ) : null}
      {grants && grants.length > 0 ? (
        <Table>
          <thead>
            <tr>
              <th style={{ width: "24%" }}>{t("table.app")}</th>
              <th style={{ width: "26%" }}>{t("table.user")}</th>
              <th>{t("table.scopes")}</th>
              <th>{t("table.granted")}</th>
              <th>{t("table.expires")}</th>
              <th className="right" aria-label={t("table.menu")} />
            </tr>
          </thead>
          <tbody>
            {grants.map((grant) => {
              const name = grant.clientName || grant.clientId;
              return (
                <tr key={grant.id}>
                  <td className="ms-cell-fill">
                    {grant.clientUri ? (
                      <span className="ms-lead">
                        <a
                          className="ms-lead-value"
                          href={grant.clientUri}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <Truncated text={name} />
                        </a>
                      </span>
                    ) : (
                      <Truncated text={name} />
                    )}
                  </td>
                  <LeadCell
                    value={grant.userEmail ?? "—"}
                    action={
                      grant.own ? (
                        <span className="ms-badge ms-badge-neutral">{t("you")}</span>
                      ) : undefined
                    }
                  />
                  <td>
                    <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      {grant.allTeams ? (
                        <span className="ms-badge ms-badge-neutral">{t("allTeams")}</span>
                      ) : null}
                      <Tooltip inline text={grant.scopes.join("\n")}>
                        <span className="ms-chip">
                          {t("scopesCount", { count: grant.scopes.length })}
                        </span>
                      </Tooltip>
                    </span>
                  </td>
                  <td>{grant.grantedAt ? <RelativeTime date={grant.grantedAt} /> : "—"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {grant.expiresAt ? formatDate(grant.expiresAt, locale) : t("untilDisconnected")}
                  </td>
                  <td className="right">
                    <PopoverMenu
                      ariaLabel={t("table.menu")}
                      items={[
                        {
                          label: t("revoke"),
                          danger: true,
                          onSelect: () => setRevokeTarget({ id: grant.id, name }),
                        },
                      ]}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      ) : null}

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
            {revokeMutation.isError ? (
              <p className="ms-field-error" style={{ margin: 0 }}>
                {revokeMutation.error.data?.code === "FORBIDDEN"
                  ? t("revokeAllTeamsForbidden")
                  : revokeMutation.error.message}
              </p>
            ) : null}
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
    </div>
  );
}
