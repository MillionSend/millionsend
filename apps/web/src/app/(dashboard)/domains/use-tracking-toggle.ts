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
 * confirms first — the change touches every future send — then routes into the
 * onboarding flow instead of persisting in place. It routes there whenever the
 * subdomain still needs setting up (cloud, no CNAME yet) OR a configured domain
 * is turning tracking back on from fully off, so re-enabling always walks the
 * same screen as first setup and "change subdomain". Flipping the second kind
 * on while the first is already live, and any disable, just persist. Both call
 * sites keep their own mutation instance and stay in sync via invalidation.
 */
export function useTrackingToggle(
  id: string,
  opts: {
    needsOnboarding: boolean;
    hasSubdomain: boolean;
    clickTracking: boolean;
    openTracking: boolean;
  },
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

  const bothOff = !opts.clickTracking && !opts.openTracking;
  // Turning tracking on goes through onboarding when there's no CNAME to serve
  // it yet, or when a configured domain is being switched back on from off.
  const enableRoutesToOnboarding = opts.needsOnboarding || (opts.hasSubdomain && bothOff);

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
    if (checked && enableRoutesToOnboarding) {
      router.push(`/domains/${id}/tracking?enable=${kind}`);
      return;
    }
    update.mutate({
      id,
      ...(kind === "click" ? { clickTracking: checked } : { openTracking: checked }),
    });
  }

  /** The Records-tab group switch: on = onboard (or enable click); off = both off. */
  async function toggleMaster(checked: boolean) {
    if (!(await confirm(t("detail.tracking.kindBoth"), checked))) return;
    if (checked && enableRoutesToOnboarding) {
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
