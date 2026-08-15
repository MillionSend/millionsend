import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { SettingsTabs } from "../settings-tabs";
import { SmtpView } from "./smtp-view";

export default async function SmtpPage() {
  const t = await getTranslations("settings");
  return (
    <>
      <PageHeader title={t("smtp.title")} />
      <SettingsTabs />
      <SmtpView />
    </>
  );
}
