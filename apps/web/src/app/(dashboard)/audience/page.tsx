"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { PageHeader } from "@/components/page-header";
import { readLastAudience, writeLastAudience } from "@/lib/last-audience";
import { useTRPC } from "@/lib/trpc";
import { AudienceTabs } from "./audience-tabs";
import { AudienceContactsView } from "./contacts-view";

/**
 * The Contacts tab's landing page: renders the Contacts surface of the
 * currently-selected audience (the one last viewed, else the team's first by
 * createdAt). A team with no audiences gets its "General" default created
 * automatically — the dashboard never demands "create an audience" before the
 * first contact. /audience/[id] stays the canonical per-audience URL.
 */
export default function AudiencePage() {
  const t = useTranslations("audience");
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const team = useQuery(trpc.team.list.queryOptions());
  const audiences = useQuery(trpc.audience.audiences.list.queryOptions());
  const teamId = team.data?.activeTeamId ?? null;

  const ensureDefault = useMutation(
    trpc.audience.audiences.ensureDefault.mutationOptions({
      onSuccess: async ({ id }) => {
        if (teamId) writeLastAudience(teamId, id);
        await queryClient.invalidateQueries(trpc.audience.audiences.list.queryFilter());
      },
    }),
  );
  const ensured = useRef(false);
  const ensure = ensureDefault.mutate;
  useEffect(() => {
    if (audiences.data?.length === 0 && !ensured.current) {
      ensured.current = true;
      ensure();
    }
  }, [audiences.data, ensure]);

  if (audiences.isPending || team.isPending || (audiences.data?.length ?? 0) === 0) {
    return (
      <>
        <PageHeader title={t("list.title")} />
        <AudienceTabs />
      </>
    );
  }

  const list = audiences.data ?? [];
  const persisted = teamId ? readLastAudience(teamId) : null;
  const earliest = [...list].sort(
    (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt),
  )[0] as (typeof list)[number];
  const defaultId = persisted && list.some((a) => a.id === persisted) ? persisted : earliest.id;

  return <AudienceContactsView key={defaultId} audienceId={defaultId} />;
}
