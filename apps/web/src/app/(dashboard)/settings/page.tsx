import { env } from "@millionsend/config";
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
      {/* Instance settings steer the whole deployment — an operator concern
          that exists only on self-host; cloud tenants never see them. */}
      <SettingsSections showInstance={!env.IS_CLOUD} />
    </>
  );
}
