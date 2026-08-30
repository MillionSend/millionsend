import { getTranslations } from "next-intl/server";
import { StatusPage } from "@/components/status-page";
import { DOCS_URL } from "@/lib/docs-links";

export default async function NotFound() {
  const t = await getTranslations("common.notFound");
  return (
    <StatusPage
      code="404"
      title={t("title")}
      body={t("body")}
      actions={
        <>
          <a className="ms-btn ms-btn-primary" href="/emails">
            {t("cta")}
          </a>
          <a className="ms-btn ms-btn-secondary" href={DOCS_URL} target="_blank" rel="noreferrer">
            {t("docs")}
          </a>
        </>
      }
    />
  );
}
