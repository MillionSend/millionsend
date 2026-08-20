"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { DraftBanner } from "@/components/draft-banner";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { isMailyDoc } from "@/lib/email-doc";
import { buildMergeOptions } from "@/lib/merge-fields";
import { useTRPC } from "@/lib/trpc";
import { useLocalDraft } from "@/lib/use-local-draft";
import { useUnsavedChangesWarning } from "@/lib/use-unsaved-warning";
import { ContentPreview } from "../broadcasts/parts";

// Client-only: the Maily editor pulls in tiptap and touches the DOM, so it
// must not render on the server. The ghost holds the field's height meanwhile.
const MailyEditor = dynamic(() => import("@/components/maily-editor").then((m) => m.default), {
  ssr: false,
  loading: () => <Skeleton width="100%" height={340} radius="var(--ms-r-input)" />,
});

/** Everything a crash would lose — mirrored into the local draft. */
interface TemplateDraft {
  name: string;
  subject: string;
  html: string;
  text: string;
  document: unknown;
}

export interface EditorInitial {
  id: string;
  name: string;
  subject: string | null;
  html: string;
  text: string | null;
  document: unknown;
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
  const common = useTranslations("common");
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [name, setName] = useState(initial?.name ?? "");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [html, setHtml] = useState(initial?.html ?? "");
  const [text, setText] = useState(initial?.text ?? "");
  const [document, setDocument] = useState<unknown>(initial?.document ?? null);
  const [tab, setTab] = useState<"edit" | "preview">("edit");

  // Unsaved-body tracking for the native leave warning: the baseline is the
  // last-persisted document (or the editor's very first emit for a new one);
  // any later emit that differs arms beforeunload until the next save.
  const [dirty, setDirty] = useState(false);
  const savedDoc = useRef<string | null>(
    initial !== undefined ? JSON.stringify(initial.document ?? null) : null,
  );
  useUnsavedChangesWarning(dirty, common("unsavedWarn"));

  // Local crash-recovery draft (browser-only, one key per template).
  const [editorNonce, setEditorNonce] = useState(0);
  const draftState = useMemo<TemplateDraft>(
    () => ({ name, subject, html, text, document }),
    [name, subject, html, text, document],
  );
  const draft = useLocalDraft<TemplateDraft>({
    storageKey: `ms-draft:template:${initial?.id ?? "new"}`,
    state: draftState,
    initialState: {
      name: initial?.name ?? "",
      subject: initial?.subject ?? "",
      html: initial?.html ?? "",
      text: initial?.text ?? "",
      document: initial?.document ?? null,
    },
  });

  function restoreDraft(data: TemplateDraft) {
    setName(data.name);
    setSubject(data.subject);
    setHtml(data.html);
    setText(data.text);
    setDocument(data.document);
    // The editor seeds once from its mount value — remount it.
    setEditorNonce((n) => n + 1);
    // A restored draft is unsaved by definition: poison the baseline so the
    // editor's next emit differs and the leave-guard arms immediately.
    savedDoc.current = "__restored__";
    setDirty(true);
    draft.acceptRecovered();
  }

  // Merge-field picker options and preview sample values both derive from the
  // team's contact-property keys in use, plus its typed definitions so a
  // defined key is insertable before any contact carries a value.
  const properties = useQuery(trpc.audience.properties.list.queryOptions());
  const definedProps = useQuery(trpc.audience.properties.defineList.queryOptions());
  const mergeFields = useMemo(
    () =>
      buildMergeOptions([
        ...(properties.data ?? []).map((p) => p.key),
        ...(definedProps.data ?? []).map((p) => p.key),
      ]),
    [properties.data, definedProps.data],
  );
  const previewSamples = useMemo(
    () => Object.fromEntries((properties.data ?? []).map((p) => [p.key, p.sampleValue])),
    [properties.data],
  );

  // Send html is rendered server-side (Maily needs juice), so a design-mode
  // edit cannot emit it — this debounced render both feeds the preview and
  // supplies the html we persist. A legacy raw-html document keeps its stored
  // html untouched until the first real edit converts it (see MailyEditor).
  const [debouncedDoc, setDebouncedDoc] = useState<unknown>(document);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedDoc(document), 350);
    return () => clearTimeout(id);
  }, [document]);
  const rendered = useQuery(
    trpc.email.render.queryOptions(
      { document: debouncedDoc },
      { enabled: isMailyDoc(debouncedDoc) },
    ),
  );
  useEffect(() => {
    if (!rendered.data) return;
    setHtml(rendered.data.html);
    setText(rendered.data.text);
  }, [rendered.data]);

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
        document,
      });
      savedDoc.current = JSON.stringify(document);
      setDirty(false);
      draft.markSaved();
      return initial.id;
    }
    const { id } = await createMutation.mutateAsync({
      name: name.trim(),
      ...(subject.trim() ? { subject: subject.trim() } : {}),
      html,
      ...(text ? { text } : {}),
      ...(document ? { document } : {}),
    });
    savedDoc.current = JSON.stringify(document);
    setDirty(false);
    draft.markSaved();
    return id;
  }

  // Transient "✓ Saved" beside the Save button; the timeout below retires it.
  const [justSaved, setJustSaved] = useState(false);
  useEffect(() => {
    if (!justSaved) return;
    const id = setTimeout(() => setJustSaved(false), 2100);
    return () => clearTimeout(id);
  }, [justSaved]);

  async function save(close: boolean) {
    if (!complete || saving) return;
    try {
      const id = await persist();
      setJustSaved(true);
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
            {justSaved ? (
              <span
                role="status"
                style={{
                  color: "var(--ms-success)",
                  fontSize: "var(--ms-fs-label)",
                  // Fade-out is the shared fade-in played backwards, timed so
                  // it finishes just before the unmount timeout fires.
                  animation: "ms-fade 240ms var(--ms-ease) 1800ms reverse both",
                }}
              >
                ✓ {t("editor.saved")}
              </span>
            ) : null}
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
            <MailyEditor
              key={editorNonce}
              value={{ document, html }}
              onChange={(v) => {
                setDocument(v.document);
                const snapshot = JSON.stringify(v.document);
                // First emit of a brand-new document is the baseline, not an edit.
                if (savedDoc.current === null) savedDoc.current = snapshot;
                else if (snapshot !== savedDoc.current) setDirty(true);
              }}
              mergeFields={mergeFields}
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
                <ContentPreview
                  html={html}
                  title={t("editor.previewTab")}
                  samples={previewSamples}
                />
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
          {draft.recovered ? (
            <DraftBanner
              savedAt={draft.recovered.savedAt}
              onRestore={() => {
                const r = draft.recovered;
                if (r) restoreDraft(r.data);
              }}
              onDiscard={draft.discardRecovered}
            />
          ) : null}
        </div>

        {saveError ? (
          <p className="ms-field-error" style={{ margin: 0 }}>
            {t("editor.saveError")}
          </p>
        ) : null}
      </div>
    </>
  );
}
