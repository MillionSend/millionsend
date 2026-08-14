import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export default async function WebhooksPage() {
  const [nav, t] = await Promise.all([getTranslations("nav"), getTranslations("placeholders")]);
  return (
    <>
      <PageHeader title={nav("webhooks")} />
      <EmptyState headline={t("webhooks.count")} body={t("webhooks.body")} />
    </>
  );
}
