import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export default async function MetricsPage() {
  const [nav, t] = await Promise.all([getTranslations("nav"), getTranslations("placeholders")]);
  return (
    <>
      <PageHeader title={nav("metrics")} />
      <EmptyState headline={t("metrics.count")} body={t("metrics.body")} />
    </>
  );
}
