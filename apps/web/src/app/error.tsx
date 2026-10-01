"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { StatusPage } from "@/components/status-page";
import { reportClientError } from "@/lib/client-errors";

// Root error boundary: rendered inside the root layout, so the intl provider
// and theme still apply. The error itself goes to the console, not the user.
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // A digest marks a server error, reported on the server with that digest.
  useEffect(() => {
    if (!error.digest) reportClientError(error);
  }, [error]);
  const t = useTranslations("common.errorPage");
  return (
    <StatusPage
      code="500"
      title={t("title")}
      body={t("body")}
      actions={
        <>
          <button type="button" className="ms-btn ms-btn-primary" onClick={reset}>
            {t("retry")}
          </button>
          <a className="ms-btn ms-btn-secondary" href="/emails">
            {t("cta")}
          </a>
        </>
      }
    />
  );
}
