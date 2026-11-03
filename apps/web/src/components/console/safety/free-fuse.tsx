"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { NoticeStrip } from "@/components/notice-strip";
import { RelativeTime } from "@/components/relative-time";
import { BtnSpinner } from "@/components/spinner";
import { toast } from "@/components/toast";
import { useTRPC } from "@/lib/trpc";

/**
 * The tripped Free fuse: what tripped it and the mail it holds, released
 * behind a confirm. Renders nothing while the fuse is not tripped.
 */
export function FreeFuse({ onChanged }: { onChanged?: () => void }) {
  const t = useTranslations("console.safety.freeFuse");
  const common = useTranslations("console.common");
  const locale = useLocale();
  const nf = new Intl.NumberFormat(locale);
  const trpc = useTRPC();
  const fuse = useQuery(trpc.console.safety.freeFuse.queryOptions());
  const [confirm, setConfirm] = useState(false);
  const release = useMutation(
    trpc.console.safety.releaseFreeFuse.mutationOptions({
      onSuccess: ({ emails }) => {
        toast(t("toast", { count: emails }));
        setConfirm(false);
        void fuse.refetch();
        onChanged?.();
      },
    }),
  );
  const state = fuse.data;
  if (!state) return null;
  const submit = () => {
    if (!release.isPending) release.mutate();
  };
  return (
    <>
      <NoticeStrip
        tone="danger"
        text={t.rich("text", {
          complaints: state.complaints,
          parked: state.parked,
          parkedCount: nf.format(state.parked),
          since: () => <RelativeTime date={state.trippedAt} />,
        })}
        action={t("action")}
        onAction={() => setConfirm(true)}
      />
      <Modal open={confirm} onClose={() => setConfirm(false)} onConfirm={submit} title={t("title")}>
        <p style={{ margin: "0 0 18px", fontSize: 13, color: "var(--ms-muted)" }}>
          {t("lead", { parked: state.parked, parkedCount: nf.format(state.parked) })}
        </p>
        {release.isError ? (
          <p style={{ margin: "0 0 12px", color: "var(--ms-danger)", fontSize: 13 }}>
            {release.error.message}
          </p>
        ) : null}
        <ModalFooter>
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            onClick={() => setConfirm(false)}
          >
            {common("cancel")} <span className="ms-keycap">Esc</span>
          </button>
          <button
            type="button"
            className="ms-btn ms-btn-primary"
            disabled={release.isPending}
            onClick={submit}
          >
            <BtnSpinner on={release.isPending} />
            {t("confirm")} <ConfirmKeycap />
          </button>
        </ModalFooter>
      </Modal>
    </>
  );
}
