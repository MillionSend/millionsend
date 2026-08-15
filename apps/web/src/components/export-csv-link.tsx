import { useTranslations } from "next-intl";

/**
 * "Export CSV" affordance for a list header. Downloads from the /export route
 * handler, which streams only the caller's team data; `href` carries the
 * surface (e.g. /export/contacts) plus the list's current filters as query
 * params so the file mirrors what's on screen.
 */
export function ExportCsvLink({ href }: { href: string }) {
  const common = useTranslations("common");
  return (
    <a className="ms-btn ms-btn-secondary" href={href}>
      {common("exportCsv")}
    </a>
  );
}
