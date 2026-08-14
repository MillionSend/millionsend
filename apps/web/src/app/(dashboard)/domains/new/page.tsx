import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { getAuth } from "@/server/auth";
import { AddDomainForm } from "./add-domain-form";

export default async function NewDomainPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string }>;
}) {
  const [nav, t, session, params] = await Promise.all([
    getTranslations("nav"),
    getTranslations("domains"),
    headers().then((h) => getAuth().api.getSession({ headers: h })),
    searchParams,
  ]);
  return (
    <>
      <PageHeader
        title={t("new.title")}
        subtitle={t(params.created ? "new.stepLine2" : "new.stepLine")}
        breadcrumb={
          <>
            <Crumb href="/domains" label={nav("domains")} />
            <CrumbEnd label={t("new.title")} />
          </>
        }
      />
      {/* The dashboard layout already redirects unauthenticated users; the
          fallback only satisfies the nullable session type. */}
      <AddDomainForm userEmail={session?.user.email ?? ""} />
    </>
  );
}
