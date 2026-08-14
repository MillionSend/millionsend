import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { SettingsTabs } from "../settings-tabs";
import { UsageView } from "./usage-view";

export default async function UsagePage() {
  const t = await getTranslations("settings");
  return (
    <>
      <PageHeader title={t("tabs.usage")} />
      <SettingsTabs />
      <UsageView />
    </>
  );
}
