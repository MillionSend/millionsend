import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { AudienceTabs } from "./audience-tabs";

/** Shared body of the not-yet-built Audience sections (§9.4 names them). */
export async function AudiencePlaceholderPage({
  section,
}: {
  section: "properties" | "segments" | "topics";
}) {
  const t = await getTranslations("audience");
  return (
    <>
      <PageHeader title={t("list.title")} />
      <AudienceTabs />
      <EmptyState
        area="audience"
        headline={t(`placeholder.${section}`)}
        body={t("placeholder.notAvailable")}
      />
    </>
  );
}
