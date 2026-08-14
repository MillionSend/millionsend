import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export default async function LogsPage() {
  const [nav, t] = await Promise.all([getTranslations("nav"), getTranslations("placeholders")]);
  return (
    <>
      <PageHeader title={nav("logs")} />
      <EmptyState headline={t("logs.count")} body={t("logs.body")} />
    </>
  );
}
