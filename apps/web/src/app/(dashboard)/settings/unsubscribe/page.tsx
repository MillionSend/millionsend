import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { SettingsTabs } from "../settings-tabs";
import { UnsubscribeView } from "./unsubscribe-view";

export default async function UnsubscribeSettingsPage() {
  const t = await getTranslations("settings");
  return (
    <>
      <PageHeader title={t("unsubscribe.title")} />
      <SettingsTabs />
      <UnsubscribeView />
    </>
  );
}
