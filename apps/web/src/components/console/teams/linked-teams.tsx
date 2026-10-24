"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Table } from "@/components/table";
import { Truncated } from "@/components/truncated";
import { formatRelative } from "@/lib/format";
import { consoleReviewHref } from "@/lib/nav";
import { useTRPC } from "@/lib/trpc";
import { CardHead } from "../safety/parts";

/**
 * What the team shares with teams suspended for phishing, one row per
 * matched fingerprint; nothing at all for a team that matched none.
 * `framed` sets it in its own card, as a page section.
 */
export function LinkedTeams({ teamId, framed = false }: { teamId: string; framed?: boolean }) {
  const t = useTranslations("console.teams.linked");
  const locale = useLocale();
  const trpc = useTRPC();
  const query = useQuery(trpc.console.accounts.links.queryOptions({ teamId }));
  const links = query.data ?? [];
  if (links.length === 0) return null;
  const shown = (kind: string, value: string) => (kind === "text_hash" ? t("sameText") : value);

  const body = (
    <>
      <CardHead title={t("title")} subtitle={t("subtitle")} />
      <Table>
        <thead>
          <tr>
            <th>{t("columns.signal")}</th>
            <th style={{ width: "30%" }}>{t("columns.thisTeam")}</th>
            <th style={{ width: "30%" }}>{t("columns.matched")}</th>
            <th>{t("columns.team")}</th>
          </tr>
        </thead>
        <tbody>
          {links.flatMap((link) =>
            link.matches.map((match) => (
              <tr key={`${link.linkedTeamId}:${match.kind}:${match.value}:${match.matched}`}>
                <td>{t(`kinds.${match.kind}`)}</td>
                <td className="ms-cell-fill ms-mono">
                  <Truncated text={shown(match.kind, match.value)} />
                </td>
                <td className="ms-cell-fill ms-mono">
                  <Truncated text={shown(match.kind, match.matched)} />
                </td>
                <td>
                  <Link className="ms-link" href={consoleReviewHref(link.linkedTeamId)}>
                    {link.linkedTeamName}
                  </Link>
                </td>
              </tr>
            )),
          )}
        </tbody>
      </Table>
      {links.map((link) => (
        <p
          key={link.linkedTeamId}
          style={{ margin: "10px 0 0", fontSize: 12, color: "var(--ms-muted)" }}
        >
          {t("found", {
            team: link.linkedTeamName,
            ago: formatRelative(link.createdAt, locale),
            trigger: t(`triggers.${link.trigger}`),
          })}{" "}
          {t(link.held ? "held" : "notHeld")}
        </p>
      ))}
    </>
  );
  return framed ? (
    <div className="ms-card" style={{ padding: 20, marginBottom: 16 }}>
      {body}
    </div>
  ) : (
    <section style={{ marginTop: 24 }}>{body}</section>
  );
}
