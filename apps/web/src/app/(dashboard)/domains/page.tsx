import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { DomainsTable } from "./domains-table";

export default async function DomainsPage() {
  const [nav, t] = await Promise.all([getTranslations("nav"), getTranslations("domains")]);
  return (
    <>
      <PageHeader
        title={nav("domains")}
        actions={
          <Link
            href="/domains/new"
            className="ms-btn ms-btn-primary"
            style={{ textDecoration: "none" }}
          >
            {t("list.addDomain")}
          </Link>
        }
      />
      <DomainsTable />
    </>
  );
}
