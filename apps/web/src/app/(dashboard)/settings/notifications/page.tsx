import { env } from "@millionsend/config";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { SettingsTabs } from "../settings-tabs";
import { NotificationsView } from "./notifications-view";

export default async function NotificationsSettingsPage() {
  const t = await getTranslations("settings");
  return (
    <>
      <PageHeader title={t("notifications.title")} />
      <SettingsTabs />
      {/* Billing notices exist only where billing does. */}
      <NotificationsView cloud={env.IS_CLOUD} />
    </>
  );
}
