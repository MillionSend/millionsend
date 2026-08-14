import { getTranslations } from "next-intl/server";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { AddDomainForm } from "./add-domain-form";

export default async function NewDomainPage() {
  const [nav, t] = await Promise.all([getTranslations("nav"), getTranslations("domains")]);
  return (
    <>
      <PageHeader
        title={t("new.title")}
        subtitle={t("new.stepLine")}
        breadcrumb={
          <>
            <Crumb href="/domains" label={nav("domains")} />
            <CrumbEnd label={t("new.title")} />
          </>
        }
      />
      <AddDomainForm />
    </>
  );
}
