"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudienceSelect } from "@/components/audience-select";
import { FromField } from "@/components/from-field";
import { Modal } from "@/components/modal";
import { ModalFooter } from "@/components/modal-footer";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { Select } from "@/components/select";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { MarkerRail, MobileStepBar, StepRail } from "@/components/stepper";
import { isMailyDoc } from "@/lib/email-doc";
import { buildMergeOptions } from "@/lib/merge-fields";
import { statusGlow } from "@/lib/status-glow";
import { useTRPC } from "@/lib/trpc";
import { useUnsavedChangesWarning } from "@/lib/use-unsaved-warning";
import { ContentPreview } from "./parts";

// Client-only: the Maily editor pulls in tiptap and touches the DOM, so it
// must not render on the server. The ghost holds the field's height meanwhile.
const MailyEditor = dynamic(() => import("@/components/maily-editor").then((m) => m.default), {
  ssr: false,
  loading: () => <Skeleton width="100%" height={340} radius="var(--ms-r-input)" />,
});

export interface ComposerInitial {
  id: string;
  audienceId: string | null;
  topicId: string | null;
  segmentId: string | null;
  name: string | null;
  from: string;
  subject: string;
  replyTo: string | null;
  html: string | null;
  text: string | null;
  document: unknown;
}

/** Ghost of the composer while an existing draft loads — same field boxes, no shift. */
export function ComposerSkeleton() {
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
        {["100%", "100%", "100%", "100%"].map((width, row) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows, position is identity
          <div key={row}>
            <Skeleton width={90} height={11} />
            <div style={{ marginTop: 8, display: "flex" }}>
              <Skeleton width={width} height={38} radius="var(--ms-r-input)" />
            </div>
          </div>
        ))}
        <Skeleton width="100%" height={260} radius="var(--ms-r-input)" />
      </div>
    </>
  );
}

export function BroadcastComposer({ initial }: { initial?: ComposerInitial }) {
  const t = useTranslations("broadcasts");
  const tTemplates = useTranslations("templates");
  const common = useTranslations("common");
  const locale = useLocale();
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const [audienceId, setAudienceId] = useState(initial?.audienceId ?? "");
  const [topicId, setTopicId] = useState(initial?.topicId ?? "");
  const [segmentId, setSegmentId] = useState(initial?.segmentId ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [from, setFrom] = useState(initial?.from ?? "");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [replyTo, setReplyTo] = useState(initial?.replyTo ?? "");
  const [html, setHtml] = useState(initial?.html ?? "");
  const [text, setText] = useState(initial?.text ?? "");
  const [document, setDocument] = useState<unknown>(initial?.document ?? null);
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [guardOpen, setGuardOpen] = useState(false);
  const [schedule, setSchedule] = useState("");
  const [templateId, setTemplateId] = useState("");
  // Editing an existing draft lands on step 2 (targeting is a recap there);
  // a new broadcast starts at step 1: audience + name.
  const [step, setStep] = useState<1 | 2>(initial ? 2 : 1);

  // Unsaved-body tracking for the native leave warning: the baseline is the
  // last-persisted document (or the editor's very first emit for a new one);
  // any later emit that differs arms beforeunload until the next save.
  const [dirty, setDirty] = useState(false);
  const savedDoc = useRef<string | null>(
    initial !== undefined ? JSON.stringify(initial.document ?? null) : null,
  );
  useUnsavedChangesWarning(dirty, common("unsavedWarn"));

  const audiences = useQuery(trpc.audience.audiences.list.queryOptions());
  const topics = useQuery(trpc.topics.list.queryOptions());
  const segments = useQuery(trpc.segments.list.queryOptions());
  // Segments are audience-scoped; only offer ones that filter the chosen audience.
  const audienceSegments = (segments.data ?? []).filter((s) => s.audienceId === audienceId);
  const selectedAudience = (audiences.data ?? []).find((a) => a.id === audienceId) ?? null;
  const templates = useQuery(trpc.templates.list.queryOptions({ limit: 50 }));
  const templateOptions = templates.data?.items ?? [];

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

  /** Copies the template's content in as a starting snapshot — no link back;
   * later template edits change nothing here. */
  async function applyTemplate(id: string) {
    setTemplateId(id);
    if (!id) return;
    const template = await queryClient.fetchQuery(trpc.templates.get.queryOptions({ id }));
    if (template.subject) setSubject(template.subject);
    setHtml(template.html);
    setText(template.text ?? "");
    setDocument(template.document);
  }
  const recipientCount = useQuery(
    trpc.broadcasts.recipientCount.queryOptions(
      { audienceId, topicId: topicId || null, segmentId: segmentId || null },
      { enabled: guardOpen && !!audienceId },
    ),
  );

  const createMutation = useMutation(trpc.broadcasts.create.mutationOptions());
  const updateMutation = useMutation(trpc.broadcasts.update.mutationOptions());
  const sendMutation = useMutation(trpc.broadcasts.send.mutationOptions());

  const complete = audienceId !== "" && from.trim() !== "" && subject.trim() !== "";
  const saving = createMutation.isPending || updateMutation.isPending;
  const sending = saving || sendMutation.isPending;

  const invalidate = () => queryClient.invalidateQueries(trpc.broadcasts.pathFilter());

  /** Create-or-update the draft; returns its id. */
  async function persist(): Promise<string> {
    if (initial) {
      await updateMutation.mutateAsync({
        id: initial.id,
        audienceId,
        topicId: topicId || null,
        segmentId: segmentId || null,
        ...(name.trim() ? { name: name.trim() } : { name: "" }),
        from: from.trim(),
        subject: subject.trim(),
        replyTo: replyTo.trim(),
        html,
        text,
        document,
      });
      savedDoc.current = JSON.stringify(document);
      setDirty(false);
      return initial.id;
    }
    const { id } = await createMutation.mutateAsync({
      audienceId,
      ...(topicId ? { topicId } : {}),
      ...(segmentId ? { segmentId } : {}),
      ...(name.trim() ? { name: name.trim() } : {}),
      from: from.trim(),
      subject: subject.trim(),
      ...(replyTo.trim() ? { replyTo: replyTo.trim() } : {}),
      ...(html ? { html } : {}),
      ...(text ? { text } : {}),
      ...(document ? { document } : {}),
    });
    savedDoc.current = JSON.stringify(document);
    setDirty(false);
    return id;
  }

  async function saveDraft() {
    if (!complete || saving) return;
    try {
      const id = await persist();
      invalidate();
      if (!initial) router.replace(`/broadcasts/${id}/edit`);
    } catch {
      // Shown via the mutations' error state.
    }
  }

  async function confirmSend() {
    if (!complete || sending) return;
    try {
      const id = await persist();
      await sendMutation.mutateAsync({
        id,
        ...(schedule ? { scheduledAt: new Date(schedule) } : {}),
      });
      invalidate();
      router.push(`/broadcasts/${id}`);
    } catch {
      // Shown via the mutations' error state.
    }
  }

  const closeGuard = useCallback(() => setGuardOpen(false), []);

  const saveError = createMutation.isError || updateMutation.isError;
  const sendErrorMessage = sendMutation.isError
    ? sendMutation.error.message.includes("APP_BASE_URL")
      ? t("guard.appBaseUrl")
      : t("guard.sendError")
    : null;

  return (
    <>
      <PageHeader
        breadcrumb={
          <>
            <Crumb href="/broadcasts" label={t("composer.back")} />
            <CrumbEnd label={initial ? t("composer.editTitle") : t("composer.newTitle")} />
          </>
        }
        title={initial ? t("composer.editTitle") : t("composer.newTitle")}
        actions={
          <>
            <button
              type="button"
              className="ms-btn ms-btn-secondary"
              disabled={!complete || saving}
              onClick={() => void saveDraft()}
            >
              <BtnSpinner on={saving && !guardOpen} />
              {t("composer.saveDraft")}
            </button>
            <button
              type="button"
              className="ms-btn ms-btn-primary"
              disabled={!complete}
              onClick={() => {
                sendMutation.reset();
                setGuardOpen(true);
              }}
            >
              {t("composer.send")}
            </button>
          </>
        }
      />

      {step === 1 ? (
        <div className="ms-stepper" style={{ display: "flex", gap: 44, alignItems: "flex-start" }}>
          <MobileStepBar steps={[t("composer.steps.one"), t("composer.steps.two")]} active={1} />
          <StepRail current={1} />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (audienceId !== "") setStep(2);
            }}
            style={{
              width: 520,
              flex: "none",
              background: "var(--ms-panel)",
              border: "1px solid var(--ms-line-strong)",
              borderRadius: "var(--ms-r-card)",
              padding: 24,
              boxSizing: "border-box",
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--ms-bone)" }}>
              {t("composer.steps.one")}
            </div>

            <div className="ms-field" style={{ marginTop: 16 }}>
              <label htmlFor="bc-audience">{t("composer.audienceLabel")}</label>
              <AudienceSelect
                id="bc-audience"
                value={audienceId}
                onChange={(value) => {
                  setAudienceId(value);
                  // A segment belongs to one audience; switching audiences drops it.
                  setSegmentId("");
                }}
                ariaLabel={t("composer.audienceLabel")}
                width="100%"
                options={[
                  { value: "", label: t("composer.audiencePick") },
                  ...(audiences.data ?? []).map((a) => ({
                    value: a.id,
                    label: a.name,
                    hint: t("composer.audienceHint", {
                      count: nf.format(a.contacts - a.unsubscribed),
                    }),
                  })),
                ]}
              />
            </div>

            <div className="ms-field" style={{ marginTop: 16 }}>
              <label htmlFor="bc-name">
                {t("composer.nameLabel")}{" "}
                <span style={{ color: "var(--ms-faint)", textTransform: "none" }}>
                  — {t("composer.optional")}
                </span>
              </label>
              <input
                id="bc-name"
                className="ms-input"
                style={{ width: "100%" }}
                placeholder={t("composer.nameHint")}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            {(topics.data?.length ?? 0) > 0 ? (
              <div className="ms-field" style={{ marginTop: 16 }}>
                <label htmlFor="bc-topic">{t("composer.topicLabel")}</label>
                <Select
                  id="bc-topic"
                  value={topicId}
                  onChange={setTopicId}
                  ariaLabel={t("composer.topicLabel")}
                  width="100%"
                  options={[
                    { value: "", label: t("composer.topicNone") },
                    ...(topics.data ?? []).map((topic) => ({
                      value: topic.id,
                      label: topic.name,
                    })),
                  ]}
                />
                <p
                  style={{
                    margin: "6px 0 0",
                    color: "var(--ms-muted)",
                    fontSize: "var(--ms-fs-label)",
                  }}
                >
                  {t("composer.topicHint")}
                </p>
              </div>
            ) : null}

            {audienceSegments.length > 0 ? (
              <div className="ms-field" style={{ marginTop: 16 }}>
                <label htmlFor="bc-segment">{t("composer.segmentLabel")}</label>
                <Select
                  id="bc-segment"
                  value={segmentId}
                  onChange={setSegmentId}
                  ariaLabel={t("composer.segmentLabel")}
                  width="100%"
                  options={[
                    { value: "", label: t("composer.segmentNone") },
                    ...audienceSegments.map((segment) => ({
                      value: segment.id,
                      label: segment.name,
                    })),
                  ]}
                />
                <p
                  style={{
                    margin: "6px 0 0",
                    color: "var(--ms-muted)",
                    fontSize: "var(--ms-fs-label)",
                  }}
                >
                  {t("composer.segmentHint")}
                </p>
              </div>
            ) : null}

            <div style={{ marginTop: 20 }}>
              <button type="submit" className="ms-btn ms-btn-primary" disabled={audienceId === ""}>
                {t("composer.continue")}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <div className="ms-step-col" style={{ display: "flex", flexDirection: "column" }}>
          <MobileStepBar steps={[t("composer.steps.one"), t("composer.steps.two")]} active={2} />

          {/* Step 01 — done: targeting recap with a way back */}
          <div className="ms-step" style={{ display: "flex", gap: 44 }}>
            <MarkerRail marker="01" done color="var(--ms-success)" />
            <div style={{ flex: 1, minWidth: 0, paddingBottom: 24 }}>
              <div
                style={{
                  maxWidth: 720,
                  backgroundColor: "var(--ms-ground)",
                  backgroundImage: statusGlow("success", 15),
                  border: "1px solid var(--ms-success-border)",
                  borderRadius: "var(--ms-r-card)",
                  padding: "12px 16px",
                  boxSizing: "border-box",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: "var(--ms-bone)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {selectedAudience?.name ?? t("composer.audiencePick")}{" "}
                    <span style={{ color: "var(--ms-success)", fontWeight: 400 }}>✓</span>
                    {name.trim() ? (
                      <span style={{ color: "var(--ms-muted)", fontWeight: 400 }}>
                        {" "}
                        · {name.trim()}
                      </span>
                    ) : null}
                  </div>
                  {selectedAudience ? (
                    <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--ms-muted)" }}>
                      {t("composer.audienceHint", {
                        count: nf.format(selectedAudience.contacts - selectedAudience.unsubscribed),
                      })}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="ms-btn ms-btn-secondary"
                  onClick={() => setStep(1)}
                >
                  {t("composer.stepChange")}
                </button>
              </div>
            </div>
          </div>

          {/* Step 02 — content */}
          <div className="ms-step" style={{ display: "flex", gap: 44 }}>
            <MarkerRail marker="02" color="var(--ms-bone)" line={false} />
            <div
              style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                gap: 18,
                maxWidth: 720,
              }}
            >
              {templateOptions.length > 0 ? (
                <div className="ms-field">
                  <label htmlFor="bc-template">{tTemplates("picker.label")}</label>
                  <Select
                    id="bc-template"
                    value={templateId}
                    onChange={(value) => void applyTemplate(value)}
                    ariaLabel={tTemplates("picker.label")}
                    width="100%"
                    options={[
                      { value: "", label: tTemplates("picker.none") },
                      ...templateOptions.map((template) => ({
                        value: template.id,
                        label: template.name,
                      })),
                    ]}
                  />
                  <p
                    style={{
                      margin: "6px 0 0",
                      color: "var(--ms-muted)",
                      fontSize: "var(--ms-fs-label)",
                    }}
                  >
                    {tTemplates("picker.hint")}
                  </p>
                </div>
              ) : null}

              <FromField id="bc-from" value={from} onChange={setFrom} />

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div className="ms-field">
                  <label htmlFor="bc-reply-to">
                    {t("composer.replyToLabel")}{" "}
                    <span style={{ color: "var(--ms-faint)", textTransform: "none" }}>
                      — {t("composer.optional")}
                    </span>
                  </label>
                  <input
                    id="bc-reply-to"
                    className="ms-input mono"
                    style={{ width: "100%" }}
                    value={replyTo}
                    onChange={(event) => setReplyTo(event.target.value)}
                  />
                </div>
                <div className="ms-field">
                  <label htmlFor="bc-subject">{t("composer.subjectLabel")}</label>
                  <input
                    id="bc-subject"
                    className="ms-input"
                    style={{ width: "100%" }}
                    value={subject}
                    onChange={(event) => setSubject(event.target.value)}
                  />
                </div>
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
                  <label htmlFor="bc-html" style={{ marginBottom: 0 }}>
                    {t("composer.htmlLabel")}
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
                        {t(key === "edit" ? "composer.editTab" : "composer.previewTab")}
                      </button>
                    ))}
                  </div>
                </div>
                {tab === "edit" ? (
                  <MailyEditor
                    key={templateId}
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
                        title={t("composer.previewTab")}
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
                        {t("composer.noHtml")}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {saveError && !guardOpen ? (
                <p style={{ margin: 0, color: "var(--ms-danger)", fontSize: "var(--ms-fs-label)" }}>
                  {t("composer.saveError")}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      )}

      <Modal open={guardOpen} onClose={closeGuard} title={t("guard.title")}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void confirmSend();
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void confirmSend();
            }
          }}
        >
          <p style={{ margin: "0 0 18px", fontSize: "var(--ms-fs-ui)" }}>
            {recipientCount.isPending ? (
              <span style={{ color: "var(--ms-muted)" }}>{t("guard.counting")}</span>
            ) : recipientCount.data?.count === 0 ? (
              t("guard.zero")
            ) : (
              t("guard.body", { count: nf.format(recipientCount.data?.count ?? 0) })
            )}
          </p>
          <div className="ms-field">
            <label htmlFor="bc-schedule">
              {t("guard.scheduleLabel")}{" "}
              <span style={{ color: "var(--ms-faint)", textTransform: "none" }}>
                — {t("composer.optional")}
              </span>
            </label>
            <input
              id="bc-schedule"
              type="datetime-local"
              className="ms-input"
              style={{ width: "100%" }}
              value={schedule}
              onChange={(event) => setSchedule(event.target.value)}
            />
          </div>
          {sendErrorMessage ? (
            <p
              style={{
                margin: "10px 0 0",
                color: "var(--ms-danger)",
                fontSize: "var(--ms-fs-label)",
              }}
            >
              {sendErrorMessage}
            </p>
          ) : null}
          <ModalFooter>
            <button type="button" className="ms-btn ms-btn-secondary" onClick={closeGuard}>
              {common("cancel")} <span className="ms-keycap">Esc</span>
            </button>
            <button
              type="submit"
              className="ms-btn ms-btn-primary"
              disabled={sending || recipientCount.data?.count === 0}
            >
              <BtnSpinner on={sending} />
              {schedule ? t("guard.schedule") : t("guard.sendNow")}{" "}
              <span className="ms-keycap">⌘↵</span>
            </button>
          </ModalFooter>
        </form>
      </Modal>
    </>
  );
}
