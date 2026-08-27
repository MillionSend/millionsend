import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { smtpRelayOffered } from "@/server/smtp";
import { SettingsTabs } from "../settings-tabs";
import { SmtpView } from "./smtp-view";

export default async function SmtpPage() {
  // A cloud deployment that has not exposed the relay has no SMTP to offer:
  // not forbidden, absent.
  if (!smtpRelayOffered()) notFound();
  const t = await getTranslations("settings");
  return (
    <>
      <PageHeader title={t("smtp.title")} />
      <SettingsTabs />
      <SmtpView />
    </>
  );
}
