import { env } from "@millionsend/config";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { SettingsTabs } from "../settings-tabs";
import { SesSetupView } from "./ses-setup-view";

export default async function SesSetupPage() {
  // Cloud sends through the operator's account; the instance-level SES setup
  // is a self-host screen only.
  if (env.IS_CLOUD) notFound();
  const t = await getTranslations("settings");
  return (
    <>
      <PageHeader title={t("ses.title")} />
      <SettingsTabs />
      <SesSetupView />
    </>
  );
}
