"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { useTRPC } from "@/lib/trpc";
import { ContentPreview } from "../broadcasts/parts";

export interface EditorInitial {
  id: string;
  name: string;
  subject: string | null;
  html: string;
  text: string | null;
}

/** Ghost of the editor while an existing template loads — same field boxes, no shift. */
export function EditorSkeleton() {
  return (
    <>
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", fontSize: 13, lineHeight: 1, marginBottom: 10 }}>
          <Skeleton width={150} height="1lh" />
        </div>
        <h1
          className="ms-display"
          style={{ fontSize: "var(--ms-fs-h1)", fontWeight: 600, margin: 0, display: "flex" }}
        >
          <Skeleton width={220} height="1lh" />
        </h1>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 720 }}>
        {[0, 1].map((row) => (
          <div key={row}>
            <Skeleton width={90} height={11} />
            <div style={{ marginTop: 8, display: "flex" }}>
              <Skeleton width="100%" height={38} radius="var(--ms-r-input)" />
            </div>
          </div>
        ))}
        <Skeleton width="100%" height={260} radius="var(--ms-r-input)" />
      </div>
    </>
  );
}

export function TemplateEditor({ initial }: { initial?: EditorInitial }) {
  const t = useTranslations("templates");
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [name, setName] = useState(initial?.name ?? "");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [html, setHtml] = useState(initial?.html ?? "");
  const [text, setText] = useState(initial?.text ?? "");
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [textOpen, setTextOpen] = useState(Boolean(initial?.text));

  const createMutation = useMutation(trpc.templates.create.mutationOptions());
  const updateMutation = useMutation(trpc.templates.update.mutationOptions());

  const complete = name.trim() !== "" && html.trim() !== "";
  const saving = createMutation.isPending || updateMutation.isPending;
  const saveError = createMutation.isError || updateMutation.isError;

  /** Create-or-update; returns the template id. */
  async function persist(): Promise<string> {
    if (initial) {
      await updateMutation.mutateAsync({
        id: initial.id,
        name: name.trim(),
        subject: subject.trim(),
        html,
        text,
      });
      return initial.id;
    }
    const { id } = await createMutation.mutateAsync({
      name: name.trim(),
      ...(subject.trim() ? { subject: subject.trim() } : {}),
      html,
      ...(text ? { text } : {}),
    });
    return id;
  }

  async function save(close: boolean) {
    if (!complete || saving) return;
    try {
      const id = await persist();
      queryClient.invalidateQueries(trpc.templates.pathFilter());
      if (close) router.push("/templates");
      else if (!initial) router.replace(`/templates/${id}/edit`);
    } catch {
      // Shown via the mutations' error state.
    }
  }

  // ⌘S saves, ⌘↵ saves and closes — matching the keycaps on the buttons.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "s") {
        event.preventDefault();
        void save(false);
      } else if (event.key === "Enter") {
        event.preventDefault();
        void save(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <>
      <PageHeader
        breadcrumb={
          <>
            <Crumb href="/templates" label={t("editor.back")} />
            <CrumbEnd label={initial ? t("editor.editTitle") : t("editor.newTitle")} />
          </>
        }
        title={initial ? t("editor.editTitle") : t("editor.newTitle")}
        actions={
          <>
            <button
              type="button"
              className="ms-btn ms-btn-secondary"
              disabled={!complete || saving}
              onClick={() => void save(false)}
            >
              <BtnSpinner on={saving} />
              {t("editor.save")} <span className="ms-keycap">⌘S</span>
            </button>
            <button
              type="button"
              className="ms-btn ms-btn-primary"
              disabled={!complete || saving}
              onClick={() => void save(true)}
            >
              {t("editor.saveAndClose")} <span className="ms-keycap">⌘↵</span>
            </button>
          </>
        }
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 720 }}>
        <div className="ms-field">
          <label htmlFor="tpl-name">{t("editor.nameLabel")}</label>
          <input
            id="tpl-name"
            className="ms-input"
            style={{ width: "100%" }}
            placeholder={t("editor.nameHint")}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="ms-field">
          <label htmlFor="tpl-subject">
            {t("editor.subjectLabel")}{" "}
            <span style={{ color: "var(--ms-faint)", textTransform: "none" }}>
              — {t("editor.optional")}
            </span>
          </label>
          <input
            id="tpl-subject"
            className="ms-input"
            style={{ width: "100%" }}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        </div>

        <div className="ms-field">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 6,
            }}
          >
            <label htmlFor="tpl-html" style={{ marginBottom: 0 }}>
              {t("editor.htmlLabel")}
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              {(["edit", "preview"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  style={{
                    fontSize: 13,
                    padding: "4px 10px",
                    borderRadius: 8,
                    border: 0,
                    cursor: "pointer",
                    background: tab === key ? "var(--ms-panel-raised)" : "none",
                    color: tab === key ? "var(--ms-bone)" : "var(--ms-muted)",
                    font: "inherit",
                  }}
                  onClick={() => setTab(key)}
                >
                  {t(key === "edit" ? "editor.editTab" : "editor.previewTab")}
                </button>
              ))}
            </div>
          </div>
          {tab === "edit" ? (
            <textarea
              id="tpl-html"
              className="ms-input ms-mono"
              style={{ width: "100%", minHeight: 260, resize: "vertical", lineHeight: 1.6 }}
              placeholder={t("editor.htmlPlaceholder")}
              value={html}
              onChange={(event) => setHtml(event.target.value)}
            />
          ) : (
            <div
              style={{
                border: "1px solid var(--ms-line)",
                borderRadius: "var(--ms-r-input)",
                overflow: "hidden",
              }}
            >
              {html ? (
                <ContentPreview html={html} title={t("editor.previewTab")} />
              ) : (
                <p
                  style={{
                    margin: 0,
                    padding: "16px 18px",
                    color: "var(--ms-muted)",
                    fontSize: "var(--ms-fs-ui)",
                  }}
                >
                  {t("editor.noHtml")}
                </p>
              )}
            </div>
          )}
          <p
            style={{ margin: "8px 0 0", color: "var(--ms-muted)", fontSize: "var(--ms-fs-label)" }}
          >
            {t.rich("editor.mergeHint", {
              code: (chunks) => (
                <span className="ms-mono" style={{ color: "var(--ms-bone)" }}>
                  {chunks}
                </span>
              ),
              first: "{{{FIRST_NAME|there}}}",
              last: "{{{LAST_NAME}}}",
              email: "{{{EMAIL}}}",
              unsub: "{{{UNSUBSCRIBE_URL}}}",
            })}
          </p>
        </div>

        <div>
          <button
            type="button"
            className="ms-btn ms-btn-ghost"
            aria-expanded={textOpen}
            onClick={() => setTextOpen((v) => !v)}
          >
            {textOpen ? "▾" : "▸"} {t(textOpen ? "editor.textToggleHide" : "editor.textToggleShow")}
          </button>
          {textOpen ? (
            <div className="ms-field" style={{ marginTop: 10 }}>
              <label htmlFor="tpl-text">{t("editor.textLabel")}</label>
              <textarea
                id="tpl-text"
                className="ms-input ms-mono"
                style={{ width: "100%", minHeight: 140, resize: "vertical", lineHeight: 1.6 }}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </div>
          ) : null}
        </div>

        {saveError ? (
          <p style={{ margin: 0, color: "var(--ms-danger)", fontSize: "var(--ms-fs-label)" }}>
            {t("editor.saveError")}
          </p>
        ) : null}
      </div>
    </>
  );
}
