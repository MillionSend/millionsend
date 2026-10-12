"use client";

import { useTranslations } from "next-intl";
import { BetaPill } from "@/components/beta-pill";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { ReceivedEmailsList } from "./received-list";

export function ReceivedView() {
  const t = useTranslations("inboxes");
  return (
    <>
      <PageHeader
        breadcrumb={
          <>
            <Crumb href="/inboxes" label={t("title")} />
            <CrumbEnd label={t("received.title")} />
          </>
        }
        title={t("received.title")}
        badges={<BetaPill />}
      />
      <p style={{ margin: "0 0 16px", fontSize: 13, color: "var(--ms-muted)" }}>
        {t("received.hint")}
      </p>
      <ReceivedEmailsList />
    </>
  );
}
