"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { Table } from "@/components/table";
import { Tooltip } from "@/components/tooltip";
import { Truncated } from "@/components/truncated";
import { IP_GEO_SOURCE_URL } from "@/lib/docs-links";
import { countryFlag, formatDayTime, formatRelative } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";
import { CardHead } from "../safety/parts";

const STATUS_DOT = {
  suspended: "var(--ms-danger)",
  deleted: "var(--ms-faint)",
  active: "var(--ms-success)",
} as const;

/**
 * The team's people as the console investigates them: where each signed up
 * from, with the network and country when IP geolocation is on, the IP of
 * their latest session, and the other accounts seen on those IPs.
 */
export function MembersSection({ teamId }: { teamId: string }) {
  const t = useTranslations("console.teams.members");
  const common = useTranslations("console.common");
  const roles = useTranslations("settings.members.roles");
  const reasons = useTranslations("console.teams.suspendDialog.reasons");
  const locale = useLocale();
  const trpc = useTRPC();
  const query = useQuery(trpc.console.accounts.members.queryOptions({ teamId }));
  if (!query.data) return null;
  const { members, others, geo } = query.data;
  const none = common("none");
  const located = members.some((m) => m.signup?.geo?.asn || m.signup?.geo?.country);

  return (
    <section style={{ marginTop: 24 }}>
      <CardHead title={t("title")} subtitle={t("subtitle")} />
      <Table className="nowrap">
        <thead>
          <tr>
            <th>{t("columns.member")}</th>
            <th>{t("columns.signupIp")}</th>
            {geo ? (
              <>
                <th>{t("columns.network")}</th>
                <th>{t("columns.country")}</th>
              </>
            ) : null}
            <th>{t("columns.lastSeen")}</th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => {
            const network = member.signup?.geo;
            return (
              <tr key={member.userId}>
                <td>
                  <Tooltip
                    inline
                    text={t("memberTip", { name: member.name, role: roles(member.role) })}
                  >
                    {member.email}
                  </Tooltip>
                </td>
                <td className="ms-mono">
                  {member.signup?.ip ? (
                    <Tooltip
                      inline
                      text={t("signupTip", {
                        date: formatDayTime(member.signup.at, locale),
                        agent: member.signup.userAgent ?? none,
                      })}
                    >
                      {member.signup.ip}
                    </Tooltip>
                  ) : (
                    <Tooltip inline text={t(member.signup ? "signupNoIp" : "signupNone")}>
                      {none}
                    </Tooltip>
                  )}
                </td>
                {geo ? (
                  <>
                    <td>
                      {network?.asn ? (
                        // A cap, not a width: a short name keeps the column narrow.
                        <span style={{ display: "block", maxWidth: 220 }}>
                          <Truncated
                            text={
                              network.org ? `AS${network.asn} · ${network.org}` : `AS${network.asn}`
                            }
                          />
                        </span>
                      ) : (
                        none
                      )}
                    </td>
                    <td>
                      {network?.country ? (
                        <Tooltip
                          inline
                          text={
                            new Intl.DisplayNames([locale], { type: "region" }).of(
                              network.country,
                            ) ?? network.country
                          }
                        >
                          {countryFlag(network.country)} {network.country}
                        </Tooltip>
                      ) : (
                        none
                      )}
                    </td>
                  </>
                ) : null}
                <td className="ms-mono">
                  {member.lastSeen?.ip ? (
                    <Tooltip
                      inline
                      text={t("lastSeenTip", { ago: formatRelative(member.lastSeen.at, locale) })}
                    >
                      {member.lastSeen.ip}
                    </Tooltip>
                  ) : (
                    none
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      {others.length > 0 ? (
        <>
          <div style={{ marginTop: 20 }}>
            <CardHead title={t("othersTitle")} subtitle={t("othersSubtitle")} />
          </div>
          <Table className="nowrap">
            <thead>
              <tr>
                <th>{t("othersColumns.account")}</th>
                <th>{t("othersColumns.ip")}</th>
                <th>{t("othersColumns.seen")}</th>
                <th>{t("othersColumns.status")}</th>
              </tr>
            </thead>
            <tbody>
              {others.map((other) => {
                const status = other.suspension
                  ? "suspended"
                  : other.deleted
                    ? "deleted"
                    : "active";
                const tip = other.suspension
                  ? reasons(other.suspension)
                  : other.deleted && other.abuseSuspended
                    ? t("deletedAbuseTip")
                    : null;
                const label = (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <span
                      className="ms-dot"
                      aria-hidden="true"
                      style={{
                        background:
                          other.deleted && other.abuseSuspended
                            ? STATUS_DOT.suspended
                            : STATUS_DOT[status],
                      }}
                    />
                    {t(`status.${status}`)}
                  </span>
                );
                return (
                  <tr key={`${other.email}:${other.ip}`}>
                    <td>{other.email}</td>
                    <td className="ms-mono">{other.ip}</td>
                    <td>{t(`seen.${other.seen}`)}</td>
                    <td>
                      {tip ? (
                        <Tooltip inline text={tip}>
                          {label}
                        </Tooltip>
                      ) : (
                        label
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </>
      ) : null}
      {located ? (
        <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--ms-muted)" }}>
          {t.rich("attribution", {
            link: (chunks) => (
              <a className="ms-link" href={IP_GEO_SOURCE_URL} target="_blank" rel="noreferrer">
                {chunks}
              </a>
            ),
          })}
        </p>
      ) : null}
    </section>
  );
}
