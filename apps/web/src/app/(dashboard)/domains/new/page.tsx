import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { AddDomainForm } from "./add-domain-form";

export default async function NewDomainPage() {
  const t = await getTranslations("domains");
  return (
    <>
      <PageHeader title={t("new.title")} />
      <AddDomainForm />
    </>
  );
}
