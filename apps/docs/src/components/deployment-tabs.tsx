"use client";
import { Tab, Tabs, TabsList, TabsTrigger } from "fumadocs-ui/components/tabs";
import { useI18n } from "fumadocs-ui/contexts/i18n";
import type { ReactNode } from "react";

export type Deployment = "cloud" | "self-hosted";

// Tab values are locale-independent so the persisted choice (localStorage key
// "deployment") carries across pages and languages; only labels localize.
const EN_LABELS: Record<Deployment, string> = { cloud: "Cloud", "self-hosted": "Self-hosted" };
const LABELS: Record<string, Record<Deployment, string>> = {
  en: EN_LABELS,
  "pt-BR": { cloud: "Nuvem", "self-hosted": "Auto-hospedado" },
};

export function DeploymentTabs({ children }: { children: ReactNode }) {
  const { locale = "en" } = useI18n();
  const labels = LABELS[locale] ?? EN_LABELS;
  return (
    <Tabs groupId="deployment" persist defaultValue="cloud">
      <TabsList>
        <TabsTrigger value="cloud">{labels.cloud}</TabsTrigger>
        <TabsTrigger value="self-hosted">{labels["self-hosted"]}</TabsTrigger>
      </TabsList>
      {children}
    </Tabs>
  );
}

export function DeploymentTab({
  deployment,
  children,
}: {
  deployment: Deployment;
  children: ReactNode;
}) {
  return <Tab value={deployment}>{children}</Tab>;
}
