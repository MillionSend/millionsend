"use client";

import { INBOX_LABELS_MAX, LABEL_COLORS, LABEL_NAME_MAX } from "@millionsend/core/inbox-organize";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { GroupedMultiSelect } from "@/components/grouped-multi-select";
import { ChevronLeftIcon, TagIcon } from "@/components/icons/mail-icons";
import { PlusGlyph } from "@/components/icons/nav-icons";
import { BtnSpinner } from "@/components/spinner";
import { StatusDot } from "@/components/status-badge";
import { Tooltip } from "@/components/tooltip";
import { inLabelPalette, randomLabelColor } from "@/lib/label-colors";
import { useTRPC } from "@/lib/trpc";
import type { ThreadRow } from "../parts";

type Label = ThreadRow["labels"][number];

const GROUPS = [{ key: "labels", label: "" }];
/** Room for the color swatches on one line, so the panel keeps its width as they appear. */
const PANEL_WIDTH = 280;
// Text in the picker wraps at its width instead of widening it.
const menuText = { contain: "inline-size" } as const;
const menuError = { ...menuText, margin: "0 12px 8px", fontSize: 12 };

/**
 * A label as a neutral pill led by its color; with `onRemove`, its ✕ takes it
 * off the thread, and is handed over so focus can leave it first.
 */
export function LabelBadge({
  label,
  onRemove,
}: {
  label: Label;
  onRemove?: (button: HTMLButtonElement) => void;
}) {
  const t = useTranslations("inboxes");
  return (
    <span className="ms-badge ms-badge-neutral ms-label-badge">
      <StatusDot color={label.color} />
      {label.name}
      {onRemove ? (
        <button
          type="button"
          aria-label={t("removeLabel", { label: label.name })}
          onClick={(event) => onRemove(event.currentTarget)}
        >
          ✕
        </button>
      ) : null}
    </span>
  );
}

/**
 * The thread's Labels picker: a pick toggles a label on the thread, a new name
 * creates one in the color chosen under it (Enter alone keeps the random pick),
 * and a row's pencil opens that label's edit view.
 */
export function LabelsMenu({
  inboxId,
  labels,
  value,
  onChange,
  onCreated,
}: {
  inboxId: string;
  labels: Label[];
  value: string[];
  onChange: (next: string[]) => void;
  onCreated: (label: Label) => void;
}) {
  const t = useTranslations("inboxes");
  const tc = useTranslations("common");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [color, setColor] = useState(randomLabelColor);
  const create = useMutation(
    trpc.inboxes.labels.create.mutationOptions({
      onSuccess: (label) => {
        void queryClient.invalidateQueries({ queryKey: trpc.inboxes.labels.pathKey() });
        setColor(randomLabelColor());
        onCreated(label);
      },
    }),
  );
  const full = labels.length >= INBOX_LABELS_MAX;
  return (
    <GroupedMultiSelect
      button
      ariaLabel={t("addLabel")}
      summary={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <TagIcon />
          {t("addLabel")}
        </span>
      }
      value={value}
      options={labels.map((label) => ({
        value: label.id,
        label: label.name,
        group: "labels",
        adornment: <StatusDot color={label.color} />,
      }))}
      groups={GROUPS}
      searchPlaceholder={t("labelSearch")}
      noResultsLabel={tc("select.noResults")}
      maxLength={LABEL_NAME_MAX}
      panelMinWidth={PANEL_WIDTH}
      onCreate={(name) => create.mutateAsync({ inboxId, name, color })}
      createLabel={(name) => t("createLabel", { name })}
      createExtra={(name, submit) =>
        full ? (
          <p className="ms-field-error" style={{ ...menuError, marginTop: 6 }}>
            {t("labels.limit", { max: INBOX_LABELS_MAX })}
          </p>
        ) : (
          <form
            style={{ padding: "2px 4px 0" }}
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <LabelColorField value={color} onChange={setColor} />
            {create.error && create.variables?.name === name ? (
              <p className="ms-field-error" style={menuError}>
                {create.error.message}
              </p>
            ) : null}
          </form>
        )
      }
      editLabel={t("labels.edit")}
      editHint={t("labels.editHint")}
      renderEdit={(option, back) => {
        const label = labels.find((l) => l.id === option.value);
        return label ? (
          <LabelEditor
            key={label.id}
            inboxId={inboxId}
            label={label}
            labels={labels}
            onDone={back}
          />
        ) : null;
      }}
      onChange={onChange}
    />
  );
}

/**
 * The palette as round radio swatches, then a dashed one that opens the
 * native color picker for any other color; a custom pick fills it.
 */
export function LabelColorField({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  const t = useTranslations("inboxes");
  const id = useId();
  const custom = !inLabelPalette(value);
  return (
    <div>
      <div
        id={`${id}-label`}
        className="ms-microlabel"
        style={{ padding: "0 8px 6px", fontSize: 10.5 }}
      >
        {t("labels.color")}
      </div>
      <div className="ms-swatches">
        <div role="radiogroup" aria-labelledby={`${id}-label`}>
          {Object.entries(LABEL_COLORS).map(([key, hex]) => (
            <input
              key={key}
              type="radio"
              name={id}
              value={hex}
              className="ms-swatch"
              style={{ background: hex }}
              aria-label={t(`labels.colors.${key}`)}
              checked={value === hex}
              onChange={() => onChange(hex)}
              onKeyDown={(event) => {
                // Enter on a swatch submits, as Enter in a field does.
                if (event.key !== "Enter") return;
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }}
            />
          ))}
        </div>
        <Tooltip inline focusableChild text={t("labels.custom")}>
          <label
            className={custom ? "ms-swatch custom on" : "ms-swatch custom"}
            style={custom ? { background: value } : undefined}
          >
            {custom ? null : <PlusGlyph size={10} />}
            <input
              type="color"
              className="ms-swatch-picker"
              aria-label={t("labels.custom")}
              value={value.toLowerCase()}
              onChange={(event) => onChange(event.target.value.toUpperCase())}
            />
          </label>
        </Tooltip>
      </div>
    </div>
  );
}

/** A label's edit view inside the picker: rename, recolor, or delete after a confirm in place. */
export function LabelEditor({
  inboxId,
  label,
  labels,
  onDone,
}: {
  inboxId: string;
  label: Label;
  labels: Label[];
  onDone: () => void;
}) {
  const t = useTranslations("inboxes");
  const tc = useTranslations("common");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [name, setName] = useState(label.name);
  const [color, setColor] = useState(label.color);
  const [confirming, setConfirming] = useState(false);
  // Back from the confirm, focus returns to the button that opened it.
  const [cancelled, setCancelled] = useState(false);
  const saved = () => {
    // Thread rows and the open thread show labels too.
    void queryClient.invalidateQueries({ queryKey: trpc.inboxes.labels.pathKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.inboxes.threads.pathKey() });
    onDone();
  };
  const update = useMutation(trpc.inboxes.labels.update.mutationOptions({ onSuccess: saved }));
  const remove = useMutation(trpc.inboxes.labels.delete.mutationOptions({ onSuccess: saved }));
  const trimmed = name.trim();
  const taken = labels.some(
    (other) => other.id !== label.id && other.name.toLowerCase() === trimmed.toLowerCase(),
  );
  const error = taken ? t("labels.taken") : (update.error ?? remove.error)?.message;
  const save = () => {
    if (trimmed === "" || taken || update.isPending) return;
    const patch = {
      ...(trimmed === label.name ? {} : { name: trimmed }),
      ...(color === label.color ? {} : { color }),
    };
    if (Object.keys(patch).length === 0) onDone();
    else update.mutate({ inboxId, labelId: label.id, ...patch });
  };
  return (
    <form
      style={{ padding: 4 }}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 4px 8px" }}>
        <Tooltip inline focusableChild text={t("labels.back")}>
          <button
            type="button"
            className="ms-menu-trigger-bare"
            style={{ width: 24, height: 24 }}
            aria-label={t("labels.back")}
            onClick={onDone}
          >
            <ChevronLeftIcon />
          </button>
        </Tooltip>
        <span style={{ font: "600 13px var(--ms-font-sans)", color: "var(--ms-bone)" }}>
          {t("labels.edit")}
        </span>
      </div>
      <div style={{ padding: "0 8px 10px" }}>
        <input
          className="ms-input"
          style={{ width: "100%" }}
          // biome-ignore lint/a11y/noAutofocus: the view opens to rename, as the search it replaced had focus
          autoFocus
          aria-label={t("labels.name")}
          value={name}
          maxLength={LABEL_NAME_MAX}
          onChange={(event) => setName(event.target.value)}
        />
        {error ? (
          <span className="ms-field-error" style={{ ...menuText, marginTop: 6, fontSize: 12 }}>
            {error}
          </span>
        ) : null}
      </div>
      <LabelColorField value={color} onChange={setColor} />
      <hr className="ms-menu-sep" style={{ margin: "6px -4px 4px" }} />
      {confirming ? (
        <div style={{ padding: "4px 4px 2px 8px" }}>
          <p style={{ ...menuText, margin: "0 0 10px", fontSize: 12.5, lineHeight: 1.45 }}>
            {t("labels.deleteConfirm", { name: label.name })}
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
            <button
              type="button"
              className="ms-btn ms-btn-secondary ms-btn-sm"
              // biome-ignore lint/a11y/noAutofocus: the button that asked is gone; the safe choice takes focus
              autoFocus
              onClick={() => {
                setConfirming(false);
                setCancelled(true);
              }}
            >
              {tc("cancel")}
            </button>
            <button
              type="button"
              className="ms-btn ms-btn-destructive ms-btn-sm"
              disabled={remove.isPending}
              onClick={() => remove.mutate({ inboxId, labelId: label.id })}
            >
              <BtnSpinner on={remove.isPending} />
              {t("labels.delete")}
            </button>
          </div>
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            padding: "4px 4px 2px 0",
          }}
        >
          <button
            type="button"
            className="ms-menu-item danger"
            style={{ width: "auto" }}
            // biome-ignore lint/a11y/noAutofocus: back from the confirm it replaced
            autoFocus={cancelled}
            onClick={() => setConfirming(true)}
          >
            {t("labels.delete")}
          </button>
          <button
            type="submit"
            className="ms-btn ms-btn-primary ms-btn-sm"
            disabled={trimmed === "" || taken || update.isPending}
          >
            <BtnSpinner on={update.isPending} />
            {t("edit.save")}
          </button>
        </div>
      )}
    </form>
  );
}
