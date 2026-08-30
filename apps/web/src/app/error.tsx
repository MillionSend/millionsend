"use client";

import { useTranslations } from "next-intl";
import { StatusPage } from "@/components/status-page";

// Root error boundary: rendered inside the root layout, so the intl provider
// and theme still apply. The error itself goes to the console, not the user.
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
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
