import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { mcpResourceUrl } from "@/lib/api-base-url";
import { SettingsTabs } from "../settings-tabs";
import { McpView } from "./mcp-view";

export default async function McpPage() {
  const t = await getTranslations("settings");
  return (
    <>
      <PageHeader title={t("mcp.title")} />
      <SettingsTabs />
      <McpView serverUrl={mcpResourceUrl()} />
    </>
  );
}
