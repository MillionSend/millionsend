"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { confirmDialog } from "@/components/confirm-dialog";
import { useTRPC } from "@/lib/trpc";

type Kind = "click" | "open";

/**
 * Enabling engagement tracking is the same gesture wherever it lives (the
 * Configuration tab's per-kind switches, the Records tab's group switch): it
 * confirms first — the change touches every future send — then, when the
 * deployment still needs a tracking subdomain, routes into the onboarding flow
 * instead of persisting a toggle that would ship untracked links. Disabling
 * just persists. This hook is that shared behavior; both call sites keep their
 * own mutation instance and stay in sync through query invalidation.
 */
export function useTrackingToggle(
  id: string,
  opts: { needsOnboarding: boolean; clickTracking: boolean; openTracking: boolean },
) {
  const t = useTranslations("domains");
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const update = useMutation(
    trpc.domains.updateConfiguration.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.domains.get.queryKey({ id }) });
        void queryClient.invalidateQueries({ queryKey: trpc.domains.records.queryKey({ id }) });
      },
    }),
  );

  function confirm(kindLabel: string, enabling: boolean) {
    const state = enabling ? "Enable" : "Disable";
    return confirmDialog({
      title: t(`detail.tracking.confirm${state}Title`, { kind: kindLabel }),
      message: t(`detail.tracking.confirm${state}`, { kind: kindLabel }),
      confirmLabel: t(`detail.tracking.confirm${state}Cta`, { kind: kindLabel }),
    });
  }

  /** One kind's switch (Configuration tab). */
  async function toggleKind(kind: Kind, checked: boolean) {
    const label = t(kind === "click" ? "detail.tracking.kindClick" : "detail.tracking.kindOpen");
    if (!(await confirm(label, checked))) return;
    if (checked && opts.needsOnboarding) {
      router.push(`/domains/${id}/tracking?enable=${kind}`);
      return;
    }
    update.mutate({
      id,
      ...(kind === "click" ? { clickTracking: checked } : { openTracking: checked }),
    });
  }

  /** The Records-tab group switch: on = enable click (or onboard); off = both off. */
  async function toggleMaster(checked: boolean) {
    if (!(await confirm(t("detail.tracking.kindBoth"), checked))) return;
    if (checked && opts.needsOnboarding) {
      router.push(`/domains/${id}/tracking?enable=click`);
      return;
    }
    update.mutate(
      checked ? { id, clickTracking: true } : { id, clickTracking: false, openTracking: false },
    );
  }

  return {
    update,
    toggleKind,
    toggleMaster,
    masterChecked: opts.clickTracking || opts.openTracking,
  };
}
