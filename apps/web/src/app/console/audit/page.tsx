"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { AuditView, useActionLabel, useAuditQuery } from "@/components/console/audit/audit-view";
import { PageHeader } from "@/components/page-header";
import { Select } from "@/components/select";
import { useUrlState } from "@/lib/url-state";

export default function ConsoleAuditPage() {
  const t = useTranslations("console.audit");
  const [action, setAction] = useUrlState("action", "all");
  const [limit, setLimit] = useState(25);
  const query = useAuditQuery(action, limit);
  const actionLabel = useActionLabel();
  const actions = query.data?.pages[0]?.actions ?? [];
  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("proof")}
        actions={
          <Select
            value={action}
            onChange={setAction}
            ariaLabel={t("columns.action")}
            options={[
              { value: "all", label: t("actionAll") },
              ...actions.map((value) => ({
                value,
                label: t("action", { value: actionLabel(value) }),
              })),
            ]}
          />
        }
      />
      <AuditView query={query} limit={limit} onLimit={setLimit} />
    </>
  );
}
