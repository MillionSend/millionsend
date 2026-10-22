"use client";

import type { NewDomainLimit } from "@millionsend/core";
import { limitSpent } from "@millionsend/core/limit-rules";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { bannerLinkStyle, GradientBanner } from "@/components/gradient-banner";
import { HourglassIcon } from "@/components/icons/warmup-icons";
import { formatHoursMinutes } from "@/lib/format";

/**
 * Above the Emails list while the new domain limit holds mail: how much
 * waits, for which domain, and that it goes out on its own. Names the domain
 * when one holds it all; otherwise the count of domains, or the volume the
 * team's new domains share when that is what is spent.
 */
export function LimitBanner({ limits }: { limits: readonly NewDomainLimit[] }) {
  const t = useTranslations("emails");
  const locale = useLocale();
  const held = limits.filter((limit) => limit.waiting > 0);
  const [first] = held;
  if (!first) return null;
  const nf = new Intl.NumberFormat(locale);
  const count = held.reduce((sum, limit) => sum + limit.waiting, 0);
  const values = {
    count,
    when: held.some((limit) => limitSpent(limit)) ? "reset" : "soon",
    duration: formatHoursMinutes(new Date(first.resetsAt).getTime() - Date.now()),
  };
  const pool = held.find((limit) => limitSpent(limit) === "pool")?.pool;
  const [title, body] = pool
    ? [
        t("list.limitBanner.titleShared", { count, domains: nf.format(pool.domains) }),
        t("list.limitBanner.bodyShared", { ...values, cap: nf.format(pool.cap) }),
      ]
    : held.length === 1
      ? [
          t("list.limitBanner.title", { count, domain: first.name }),
          t("list.limitBanner.body", { ...values, cap: nf.format(first.cap) }),
        ]
      : [
          t("list.limitBanner.titleMany", { count, domains: nf.format(held.length) }),
          t("list.limitBanner.bodyMany", values),
        ];
  const one = !pool && held.length === 1;
  return (
    <GradientBanner
      variant="warn"
      icon={<HourglassIcon />}
      title={title}
      action={
        <Link href={one ? `/domains/${first.domainId}` : "/domains"} style={bannerLinkStyle}>
          {t(one ? "list.limitBanner.seeLimit" : "list.limitBanner.seeLimits")}
        </Link>
      }
      style={{ marginBottom: 20 }}
    >
      {body}
    </GradientBanner>
  );
}
