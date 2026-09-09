"use client";

import { MAIL_PREFERENCE_GROUPS, type MailPreferenceKey } from "@millionsend/core/mail-preferences";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Skeleton } from "@/components/skeleton";
import { Switch } from "@/components/switch";
import { useTRPC } from "@/lib/trpc";

/** Message ids cannot carry dots: "broadcast.held_quota" reads as "broadcast_held_quota". */
const itemId = (key: MailPreferenceKey) => key.replace(/\./g, "_");

export function NotificationsView({ cloud }: { cloud: boolean }) {
  const t = useTranslations("settings.notifications");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data } = useQuery(trpc.settings.mailPreferences.get.queryOptions());
  const set = useMutation(
    trpc.settings.mailPreferences.set.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries(trpc.settings.mailPreferences.get.queryFilter());
      },
    }),
  );
  const off = new Set<string>(data?.optOuts ?? []);
  return (
    <div style={{ maxWidth: 640, display: "grid", gap: 16 }}>
      <p style={{ margin: 0, fontSize: 13, color: "var(--ms-muted)" }}>{t("intro")}</p>
      {MAIL_PREFERENCE_GROUPS.filter((group) => cloud || !group.cloudOnly).map((group) => (
        <section key={group.group} className="ms-card" style={{ padding: 24 }}>
          <h2
            className="ms-display"
            style={{ fontSize: "var(--ms-fs-h2)", color: "var(--ms-bone)", margin: "0 0 18px" }}
          >
            {t(`groups.${group.group}`)}
          </h2>
          {group.keys.map((key) => (
            <div
              key={key}
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 16,
                marginBottom: 14,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <span
                  style={{
                    display: "block",
                    fontSize: "var(--ms-fs-label)",
                    color: "var(--ms-bone)",
                    marginBottom: 2,
                  }}
                >
                  {t(`items.${itemId(key)}.label`)}
                </span>
                <span style={{ display: "block", fontSize: 12, color: "var(--ms-muted)" }}>
                  {t(`items.${itemId(key)}.note`)}
                </span>
              </div>
              {data ? (
                <Switch
                  checked={!off.has(key)}
                  disabled={set.isPending}
                  onChange={(enabled) => set.mutate({ key, enabled })}
                  ariaLabel={t(`items.${itemId(key)}.label`)}
                />
              ) : (
                <Skeleton width={40} height={22} radius={999} />
              )}
            </div>
          ))}
        </section>
      ))}
      <p style={{ margin: 0, fontSize: 12, color: "var(--ms-muted)" }}>{t("always")}</p>
    </div>
  );
}
