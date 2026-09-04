"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { trpcErrorCode } from "@/lib/trpc-error";

/**
 * A detail page whose record failed to load. NOT_FOUND — deleted from another
 * session or the API, or another team's id — reads as gone, with the way
 * back; anything else reads as our fault, with a retry.
 */
export function LoadError({
  error,
  headline,
  notFoundHeadline,
  onRetry,
  backHref,
  backLabel,
}: {
  error: unknown;
  headline: string;
  notFoundHeadline: string;
  onRetry: () => void;
  backHref: string;
  /** The list the record belonged to, as its page title. */
  backLabel: string;
}) {
  const t = useTranslations("common.loadError");
  const gone = trpcErrorCode(error) === "NOT_FOUND";
  return (
    <div className="ms-card ms-state">
      <span className={gone ? "ms-state-glyph neutral" : "ms-state-glyph"} aria-hidden="true">
        {gone ? "?" : "!"}
      </span>
      <p className="ms-state-headline">{gone ? notFoundHeadline : headline}</p>
      <p className="ms-state-body">{t(gone ? "gone" : "ours")}</p>
      <div className="ms-state-actions">
        {gone ? null : (
          <button type="button" className="ms-btn ms-btn-secondary" onClick={onRetry}>
            {t("retry")}
          </button>
        )}
        <Link className="ms-btn ms-btn-secondary" href={backHref}>
          {t("back", { to: backLabel })}
        </Link>
      </div>
    </div>
  );
}
