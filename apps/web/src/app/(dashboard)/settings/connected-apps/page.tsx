import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { SettingsTabs } from "../settings-tabs";
import { ConnectedAppsView } from "./connected-apps-view";

export default async function ConnectedAppsPage() {
  const t = await getTranslations("settings");
  return (
    <>
      <PageHeader title={t("connectedApps.title")} />
      <SettingsTabs />
      <ConnectedAppsView />
    </>
  );
}
