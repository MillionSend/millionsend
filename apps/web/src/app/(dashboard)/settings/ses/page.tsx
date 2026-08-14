import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { SettingsTabs } from "../settings-tabs";
import { SesSetupView } from "./ses-setup-view";

export default async function SesSetupPage() {
  const t = await getTranslations("settings");
  return (
    <>
      <PageHeader title={t("ses.title")} />
      <SettingsTabs />
      <SesSetupView />
    </>
  );
}
