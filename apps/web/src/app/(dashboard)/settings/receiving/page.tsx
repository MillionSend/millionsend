import { receivingEnabled } from "@millionsend/config";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { SettingsTabs } from "../settings-tabs";
import { ReceivingView } from "./receiving-view";

export default async function ReceivingSettingsPage() {
  if (!receivingEnabled()) notFound();
  const t = await getTranslations("inboxes");
  return (
    <>
      <PageHeader title={t("settingsReceiving.title")} />
      <SettingsTabs />
      <ReceivingView />
    </>
  );
}
