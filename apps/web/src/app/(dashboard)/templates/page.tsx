import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export default async function TemplatesPage() {
  const [nav, t] = await Promise.all([getTranslations("nav"), getTranslations("placeholders")]);
  return (
    <>
      <PageHeader title={nav("templates")} />
      <EmptyState headline={t("templates.count")} body={t("templates.body")} />
    </>
  );
}
