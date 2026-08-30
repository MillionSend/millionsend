import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { SettingsTabs } from "../settings-tabs";
import { AuditView } from "./audit-view";

export default async function AuditPage() {
  const t = await getTranslations("settings");
  return (
    <>
      <PageHeader title={t("audit.title")} subtitle={t("audit.subtitle")} />
      <SettingsTabs />
      <AuditView />
    </>
  );
}
