import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export default async function AudiencePage() {
  const [nav, t] = await Promise.all([getTranslations("nav"), getTranslations("placeholders")]);
  return (
    <>
      <PageHeader title={nav("audience")} />
      <EmptyState area="audience" headline={t("audience.headline")} body={t("audience.body")} />
    </>
  );
}
