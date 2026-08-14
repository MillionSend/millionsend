import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { SettingsSections } from "./settings-sections";
import { SettingsTabs } from "./settings-tabs";

export default async function SettingsPage() {
  const t = await getTranslations("settings");
  return (
    <>
      <PageHeader title={t("tabs.settings")} />
      <SettingsTabs />
      <SettingsSections />
    </>
  );
}
