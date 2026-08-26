import { env } from "@millionsend/config";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { SettingsTabs } from "../settings-tabs";
import { BillingView } from "./billing-view";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string | string[] }>;
}) {
  // Billing does not exist on self-host: not forbidden, absent.
  if (!env.IS_CLOUD) notFound();
  const t = await getTranslations("settings");
  const raw = (await searchParams).checkout;
  const checkout = raw === "success" || raw === "cancel" ? raw : null;
  return (
    <>
      <PageHeader title={t("tabs.billing")} />
      <SettingsTabs />
      <BillingView checkout={checkout} />
    </>
  );
}
