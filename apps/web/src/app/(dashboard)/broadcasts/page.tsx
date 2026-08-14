import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export default async function BroadcastsPage() {
  const [nav, t] = await Promise.all([getTranslations("nav"), getTranslations("placeholders")]);
  return (
    <>
      <PageHeader title={nav("broadcasts")} />
      <EmptyState
        area="broadcasts"
        headline={t("broadcasts.headline")}
        body={t("broadcasts.body")}
      />
    </>
  );
}
