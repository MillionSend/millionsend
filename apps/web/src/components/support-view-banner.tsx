"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef } from "react";
import { BtnSpinner } from "@/components/spinner";
import { toast } from "@/components/toast";
import { formatMmSs } from "@/lib/format";
import { consoleTeamHref } from "@/lib/nav";
import { setReadOnly } from "@/lib/read-only";
import { useTRPC } from "@/lib/trpc";
import { trpcErrorCode } from "@/lib/trpc-error";
import { useCountdown } from "@/lib/use-countdown";

/**
 * The strip over a dashboard opened in a support view: which team, that it
 * is read-only, and how long is left. Ending clears the grant and returns
 * to the console. The countdown running out does the same, and so does a
 * poll that finds the grant gone: the owner can end a session from their
 * side, and nothing else would tell a tab already under the banner.
 */
export function SupportViewBanner({
  grantId,
  teamId,
  teamName,
  expiresAt,
}: {
  grantId: string;
  teamId: string;
  teamName: string;
  expiresAt: Date;
}) {
  const t = useTranslations("common.supportView");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const back = consoleTeamHref(teamId);
  const leave = useCallback(() => window.location.assign(back), [back]);
  const leftMs = useCountdown(expiresAt);
  const end = useMutation(trpc.support.end.mutationOptions({ onSuccess: leave }));

  // The deadline the server enforces, reached by this tab's own clock.
  useEffect(() => {
    if (leftMs === 0) leave();
  }, [leftMs, leave]);

  // The owner can end the session from their side, and the server would then
  // quietly serve this tab its own team under a banner that still names the
  // customer's. Asking after the grant is the only thing that notices.
  const live = useQuery(
    trpc.support.current.queryOptions(undefined, { refetchInterval: 15_000, staleTime: 0 }),
  );
  // Identity, not existence: starting a view of another team elsewhere leaves
  // a grant live while THIS one is over, and the banner would keep naming a
  // team the requests no longer resolve to.
  const gone = live.isSuccess && live.data?.grantId !== grantId;
  useEffect(() => {
    if (gone) leave();
  }, [gone, leave]);

  // Both markers go on the document, not on the shell. The read-only flag
  // must reach dialogs, which portal to document.body; the strip's measured
  // height is what the sticky sidebar drops by, so the page keeps to one
  // viewport instead of growing by the strip.
  const strip = useRef<HTMLDivElement>(null);
  const readOnlyMessage = t("readOnly");
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.supportView = "";
    // The seams CSS cannot dim read this instead.
    setReadOnly(true, readOnlyMessage);
    const measure = () => {
      const height = strip.current?.offsetHeight ?? 0;
      root.style.setProperty("--ms-support-strip-h", `${height}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (strip.current) observer.observe(strip.current);
    return () => {
      observer.disconnect();
      setReadOnly(false);
      delete root.dataset.supportView;
      root.style.removeProperty("--ms-support-strip-h");
    };
  }, [readOnlyMessage]);

  // Every refused mutation, from any screen, says why in one place.
  useEffect(() => {
    const readOnly = t("readOnly");
    return queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "error") return;
      const error = event.action.error as { message?: string };
      if (trpcErrorCode(error) === "FORBIDDEN" && error.message === "Read-only support view") {
        toast(readOnly, "danger");
      }
    });
  }, [queryClient, t]);

  return (
    <div
      ref={strip}
      role="status"
      className="ms-notice-strip ms-notice-strip-warn ms-support-strip"
      style={{ margin: 0, borderRadius: 0, borderWidth: "0 0 1px" }}
    >
      <span className="ms-notice-strip-text">
        {t("banner", { team: teamName })} ·{" "}
        {/* The clock runs on the client: the server's second and the browser's differ. */}
        <span suppressHydrationWarning style={{ whiteSpace: "nowrap" }}>
          {t("endsIn", { left: formatMmSs(leftMs) })}
        </span>
      </span>
      <span className="ms-notice-strip-actions">
        <Link href={back} className="ms-btn ms-btn-secondary">
          {t("back")}
        </Link>
        <button
          type="button"
          className="ms-btn ms-btn-secondary"
          disabled={end.isPending}
          onClick={() => end.mutate()}
        >
          <BtnSpinner on={end.isPending} />
          {t("end")}
        </button>
      </span>
    </div>
  );
}
