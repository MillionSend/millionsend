"use client";

import { useTranslations } from "next-intl";
import { GroupedMultiSelect, type GroupedOption } from "@/components/grouped-multi-select";
import { ClockIcon, ListFilterIcon, LockIcon, PaperclipIcon } from "@/components/icons/mail-icons";
import { StatusDot } from "@/components/status-badge";
import { manyOf } from "@/lib/list-param";
import { useUrlState } from "@/lib/url-state";
import type { ThreadRow } from "../parts";

type Label = ThreadRow["labels"][number];

const FLAGS = ["unread", "read", "awaiting", "held", "attachments"] as const;
type Flag = (typeof FLAGS)[number];
const LABEL = "label:";

export interface ThreadFilters {
  flags: Flag[];
  labels: string[];
}

export const NO_FILTERS: ThreadFilters = { flags: [], labels: [] };

/** Folder-independent, so switching folders keeps them; both are comma lists in the URL. */
export function useThreadFilters(): [ThreadFilters, (next: ThreadFilters) => void] {
  const [flags, setFlags] = useUrlState("filter");
  const [labels, setLabels] = useUrlState("labels");
  return [
    { flags: manyOf(FLAGS, flags), labels: labels ? labels.split(",") : [] },
    (next) => {
      setFlags(next.flags.join(","));
      setLabels(next.labels.join(","));
    },
  ];
}

export function hasFilters(filters: ThreadFilters): boolean {
  return filters.flags.length + filters.labels.length > 0;
}

/** What a filter set adds to the threads.list and threads.search inputs. */
export function filterInput({ flags, labels }: ThreadFilters) {
  return {
    ...(flags.includes("unread") ? { read: false } : flags.includes("read") ? { read: true } : {}),
    ...(labels.length > 0 ? { labels } : {}),
    ...(flags.includes("awaiting") ? { awaitingApproval: true } : {}),
    ...(flags.includes("held") ? { held: true } : {}),
    ...(flags.includes("attachments") ? { hasAttachments: true } : {}),
  };
}

function Glyph({ children }: { children: React.ReactNode }) {
  return <span style={{ display: "flex", color: "var(--ms-muted)" }}>{children}</span>;
}

const FLAG_ADORNMENTS: Record<Flag, React.ReactNode> = {
  unread: <StatusDot color="var(--ms-bone)" />,
  read: <StatusDot />,
  awaiting: (
    <Glyph>
      <ClockIcon />
    </Glyph>
  ),
  held: (
    <Glyph>
      <LockIcon />
    </Glyph>
  ),
  attachments: (
    <Glyph>
      <PaperclipIcon />
    </Glyph>
  ),
};

function useFlagLabel() {
  const t = useTranslations("inboxes");
  return (flag: Flag) => (flag === "unread" || flag === "read" ? t(flag) : t(`filter.${flag}`));
}

/** The Filter button: a grouped, checkable popover; Unread and Read rule each other out. */
export function ThreadFilterMenu({
  value,
  labels,
  onChange,
}: {
  value: ThreadFilters;
  labels: Label[];
  onChange: (next: ThreadFilters) => void;
}) {
  const t = useTranslations("inboxes");
  const tc = useTranslations("common");
  const flagLabel = useFlagLabel();
  const selected = [...value.flags, ...value.labels.map((id) => LABEL + id)];
  const options: GroupedOption[] = [
    ...FLAGS.map((flag) => ({
      value: flag,
      label: flagLabel(flag),
      group: flag === "unread" || flag === "read" ? "status" : "attention",
      adornment: FLAG_ADORNMENTS[flag],
    })),
    ...labels.map((label) => ({
      value: LABEL + label.id,
      label: label.name,
      group: "labels",
      adornment: <StatusDot color={label.color} />,
    })),
  ];
  return (
    <GroupedMultiSelect
      button
      ariaLabel={
        selected.length > 0
          ? t("filter.buttonCount", { count: selected.length })
          : t("filter.button")
      }
      summary={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <ListFilterIcon />
          <span>
            {t("filter.button")}
            {selected.length > 0 ? <span className="ms-count">{selected.length}</span> : null}
          </span>
        </span>
      }
      value={selected}
      options={options}
      groups={[
        { key: "status", label: t("filter.status") },
        { key: "labels", label: t("addLabel") },
        { key: "attention", label: t("filter.attention") },
      ]}
      searchPlaceholder={tc("select.searchPlaceholder")}
      noResultsLabel={tc("select.noResults")}
      onChange={(next) => {
        const added = next.find((v) => !selected.includes(v));
        const other = added === "unread" ? "read" : added === "read" ? "unread" : null;
        const kept = next.filter((v) => v !== other);
        onChange({
          flags: manyOf(FLAGS, kept.join(",")),
          labels: kept.filter((v) => v.startsWith(LABEL)).map((v) => v.slice(LABEL.length)),
        });
      }}
    />
  );
}

/** The active filters as removable chips, then Clear filters. */
export function ActiveFilters({
  value,
  labels,
  onChange,
}: {
  value: ThreadFilters;
  labels: Label[];
  onChange: (next: ThreadFilters) => void;
}) {
  const t = useTranslations("inboxes");
  const flagLabel = useFlagLabel();
  if (!hasFilters(value)) return null;
  // Focus on a ✕ moves to a neighbour's, else, as the row goes, to the Filter button.
  const remove = (button: HTMLElement, next: ThreadFilters) => {
    if (document.activeElement === button) moveFocus(button);
    onChange(next);
  };
  const chips = [
    ...value.flags.map((flag) => ({
      key: flag,
      name: flagLabel(flag),
      adornment: FLAG_ADORNMENTS[flag],
      next: { ...value, flags: value.flags.filter((f) => f !== flag) },
    })),
    ...value.labels.flatMap((id) => {
      const label = labels.find((l) => l.id === id);
      return label
        ? [
            {
              key: id,
              name: label.name,
              adornment: <StatusDot color={label.color} />,
              next: { ...value, labels: value.labels.filter((l) => l !== id) },
            },
          ]
        : [];
    }),
  ];
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        flexWrap: "wrap",
        alignItems: "center",
        margin: "-4px 0 12px",
      }}
    >
      {chips.map((chip) => (
        <span key={chip.key} className="ms-badge ms-badge-neutral ms-label-badge">
          {chip.adornment}
          {chip.name}
          <button
            type="button"
            aria-label={t("removeLabel", { label: chip.name })}
            onClick={(event) => remove(event.currentTarget, chip.next)}
          >
            ✕
          </button>
        </span>
      ))}
      <button
        type="button"
        className="ms-btn ms-btn-ghost ms-btn-sm"
        onClick={(event) => remove(event.currentTarget, NO_FILTERS)}
      >
        {t("filter.clear")}
      </button>
    </div>
  );
}

function moveFocus(button: HTMLElement) {
  const row = button.closest("div");
  const all = [...(row?.querySelectorAll<HTMLElement>(".ms-label-badge button") ?? [])];
  const at = all.indexOf(button);
  (
    (at < 0 ? undefined : (all[at + 1] ?? all[at - 1])) ??
    row?.parentElement?.querySelector<HTMLElement>('.ms-filter-row [role="combobox"]')
  )?.focus();
}
