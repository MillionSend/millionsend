"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { confirmDialog } from "@/components/confirm-dialog";
import { DraftBanner } from "@/components/draft-banner";
import { FromField } from "@/components/from-field";
import { CodeGlyph } from "@/components/icons/nav-icons";
import { MailyEditor } from "@/components/maily-editor/lazy";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { Select } from "@/components/select";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { MarkerRail, MobileStepBar, StepRail } from "@/components/stepper";
import { isEmptyMailyDoc, isMailyDoc } from "@/lib/email-doc";
import { buildMergeOptions } from "@/lib/merge-fields";
import { statusGlow } from "@/lib/status-glow";
import { bodyEditorMode, followingText } from "@/lib/template-mode";
import { useTRPC } from "@/lib/trpc";
import { useLocalDraft } from "@/lib/use-local-draft";
import { useUnsavedChangesWarning } from "@/lib/use-unsaved-warning";
import {
  BackToBlocksDialog,
  ConvertBlocksDialog,
  HtmlAuthoredBanner,
  HtmlCodeMode,
  SwitchHtmlDialog,
} from "../templates/html-mode";
import {
  ContentPreview,
  type SendPace,
  SendPlanSummary,
  sendsByWarmup,
  TestSendNote,
  type TestSendResult,
} from "./parts";

/** Everything a crash would lose — mirrored into the local draft. */
interface ComposerDraft {
  topicId: string;
  segmentId: string;
  name: string;
  from: string;
  subject: string;
  replyTo: string;
  html: string;
  text: string;
  document: unknown;
  /** Older drafts infer the mode from their content. */
  asCode?: boolean;
}

export interface ComposerInitial {
  id: string;
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

  const [topicId, setTopicId] = useState(initial?.topicId ?? "");
  const [segmentId, setSegmentId] = useState(initial?.segmentId ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [from, setFrom] = useState(initial?.from ?? "");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [replyTo, setReplyTo] = useState(initial?.replyTo ?? "");
  const [html, setHtml] = useState(initial?.html ?? "");
  const [text, setText] = useState(initial?.text ?? "");
  const [document, setDocument] = useState<unknown>(initial?.document ?? null);
  // Armed by converting to blocks in place: the block editor then mounts on
  // the html seed and emits its parse. Until then an html-authored body never
  // reaches the block editor — its html would be flattened on the first edit.
  const [converting, setConverting] = useState(false);
  // Set by "Edit as HTML" (and for a body that opened html-authored): the body
  // edits as source even while its html is empty, so clearing the textarea
  // never drops the user into the block editor. Converting to blocks in place
  // clears it, as does "Back to blocks".
  // The row has no field for the choice: a body saved empty opens in blocks again.
  const [asCode, setAsCode] = useState(
    () =>
      bodyEditorMode({ document: initial?.document ?? null, html: initial?.html ?? "" }) === "code",
  );
  const mode = bodyEditorMode({ document, html, converting, asCode });
  // An html-authored body opens on its faithful preview, not on an editor.
  const [tab, setTab] = useState<"edit" | "preview">(() => (asCode ? "preview" : "edit"));
  const [convertOpen, setConvertOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [backOpen, setBackOpen] = useState(false);
  // The body as it stood before an in-place "Edit as HTML", kept until the
  // next save: "Back to blocks" restores it exactly, where converting the html
  // back would re-parse the render and flatten it.
  const [beforeSwitch, setBeforeSwitch] = useState<{
    document: unknown;
    html: string;
    text: string;
    switchedHtml: string;
    dirty: boolean;
  } | null>(null);
  const [guardOpen, setGuardOpen] = useState(false);
  const [schedule, setSchedule] = useState("");
  // The guard's warm-up choices; skipInactive stays undefined until changed,
  // so the domain's own setting holds.
  const [pace, setPace] = useState<SendPace>("warmup");
  const [skipInactive, setSkipInactive] = useState<boolean | undefined>(undefined);
  const [templateId, setTemplateId] = useState("");
  // Editing an existing draft lands on step 2 (targeting is a recap there);
  // a new broadcast starts at step 1: targeting + name.
  const [step, setStep] = useState<1 | 2>(initial ? 2 : 1);

  // Unsaved-body tracking for the native leave warning: the baseline is the
  // last-persisted document (or the editor's very first emit for a new one);
  // any later emit that differs arms beforeunload until the next save. Code
  // mode compares the html itself.
  const [dirty, setDirty] = useState(false);
  const savedDoc = useRef<string | null>(
    initial !== undefined ? JSON.stringify(initial.document ?? null) : null,
  );
  const savedHtml = useRef(initial?.html ?? "");
  useUnsavedChangesWarning(dirty, common("unsavedWarn"));

  // Local crash-recovery draft (browser-only, one key per broadcast).
  const [editorNonce, setEditorNonce] = useState(0);
  const draftState = useMemo<ComposerDraft>(
    () => ({
      topicId,
      segmentId,
      name,
      from,
      subject,
      replyTo,
      html,
      text,
      document,
      asCode: mode === "code",
    }),
    [topicId, segmentId, name, from, subject, replyTo, html, text, document, mode],
  );
  const draft = useLocalDraft<ComposerDraft>({
    storageKey: `ms-draft:broadcast:${initial?.id ?? "new"}`,
    state: draftState,
    initialState: {
      topicId: initial?.topicId ?? "",
      segmentId: initial?.segmentId ?? "",
      name: initial?.name ?? "",
      from: initial?.from ?? "",
      subject: initial?.subject ?? "",
      replyTo: initial?.replyTo ?? "",
      html: initial?.html ?? "",
      text: initial?.text ?? "",
      document: initial?.document ?? null,
      asCode:
        bodyEditorMode({ document: initial?.document ?? null, html: initial?.html ?? "" }) ===
        "code",
    },
  });

  // Older stored drafts may carry extra fields (e.g. a dropped audienceId);
  // only the known fields are read, so they restore cleanly.
  function restoreDraft(data: ComposerDraft) {
    setTopicId(data.topicId);
    setSegmentId(data.segmentId);
    setName(data.name);
    setFrom(data.from);
    setSubject(data.subject);
    setReplyTo(data.replyTo);
    setHtml(data.html);
    setText(data.text);
    setDocument(data.document);
    setAsCode(bodyEditorMode(data) === "code");
    setConverting(false);
    setBeforeSwitch(null);
    setTab("edit");
    setStep(2);
    // The editor and From field seed once from their mount value — remount them.
    setEditorNonce((n) => n + 1);
    // A restored draft is unsaved by definition: poison the baselines so the
    // editor's next emit differs and the leave-guard arms immediately.
    savedDoc.current = "__restored__";
    savedHtml.current = "__restored__";
    setDirty(true);
    draft.acceptRecovered();
  }

  const topics = useQuery(trpc.topics.list.queryOptions());
  const segments = useQuery(trpc.segments.list.queryOptions());
  const selectedTopic = (topics.data ?? []).find((topic) => topic.id === topicId) ?? null;
  const selectedSegment = (segments.data ?? []).find((s) => s.id === segmentId) ?? null;
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
  // Code mode never takes a render: its html is the source itself.
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
    // A render that lands after a switch to code must not overwrite the source.
    if (!rendered.data || mode !== "blocks") return;
    setHtml(rendered.data.html);
    setText(rendered.data.text);
  }, [rendered.data, mode]);

  const savingNow = useRef(false);
  /** Copies the template's content in as a starting snapshot — no link back;
   * later template edits change nothing here. */
  async function applyTemplate(id: string) {
    if (!id) {
      setTemplateId("");
      return;
    }
    // Applying overwrites the body (and subject). Confirm when there is real
    // content to lose: edits this session (dirty) or a stored non-empty body
    // (text is the rendered plain text, so an empty document stays empty).
    if (dirty || text.trim() !== "") {
      const ok = await confirmDialog({
        local: true,
        title: tTemplates("picker.replaceTitle"),
        message: tTemplates("picker.replaceBody"),
        confirmLabel: tTemplates("picker.replaceConfirm"),
        danger: true,
      });
      if (!ok) return;
    }
    const template = await queryClient.fetchQuery(trpc.templates.get.queryOptions({ id }));
    // A save that started during the fetch resets the baselines for the body it
    // sent, so this body would show as saved. The picker is off while saving.
    if (savingNow.current) return;
    // templateId must land in the same batch as the content: the editor is
    // keyed on it and seeds once from its mount value, so a remount before
    // setDocument would show the old body forever.
    setTemplateId(id);
    if (template.subject) setSubject(template.subject);
    // Null only under a support view, which cannot save the broadcast anyway.
    setHtml(template.html ?? "");
    setText(template.text ?? "");
    setDocument(template.document);
    setEditorNonce((n) => n + 1);
    // The body follows the template: an html-authored one lands as html, on its
    // preview like a stored one; a block one lands in the block editor. Any
    // switch in progress is over, so its way back is gone.
    const appliedCode =
      bodyEditorMode({ document: template.document, html: template.html ?? "" }) === "code";
    setAsCode(appliedCode);
    setConverting(false);
    setBeforeSwitch(null);
    setTab(appliedCode ? "preview" : "edit");
    // Applied-but-unsaved content: poison the baselines so the editor's next
    // emit differs and the leave-guard arms immediately.
    savedDoc.current = "__applied__";
    savedHtml.current = "__applied__";
    setDirty(true);
  }
  // The plan behind the guard: the count and, when capacity, the plan or the
  // domain's warm-up paces the send, how it goes out. Re-read when the
  // schedule or the inactive choice moves, the dialog kept while the choice
  // re-plans.
  const sendPlan = useQuery(
    trpc.broadcasts.sendPlan.queryOptions(
      {
        topicId: topicId || null,
        segmentId: segmentId || null,
        from: from.trim(),
        ...(schedule ? { scheduledAt: new Date(schedule) } : {}),
        ...(skipInactive === undefined ? {} : { skipInactive }),
      },
      {
        enabled: guardOpen,
        ...(skipInactive === undefined ? {} : { placeholderData: (previous) => previous }),
      },
    ),
  );
  const warmup = sendPlan.data?.warmup ?? null;
  const byWarmup = sendsByWarmup(warmup, pace);
  // Offered while off: the send turns the domain's warm-up on.
  const enablesWarmup = byWarmup && warmup?.status !== "warming" && warmup?.status !== "paused";
  const sendBlocked =
    sendPlan.data?.count === 0 ||
    (byWarmup ? warmup?.blocked === true : sendPlan.data?.estimate?.blocked === true);

  const createMutation = useMutation(trpc.broadcasts.create.mutationOptions());
  const updateMutation = useMutation(trpc.broadcasts.update.mutationOptions());
  const sendMutation = useMutation(trpc.broadcasts.send.mutationOptions());
  const [testResult, setTestResult] = useState<TestSendResult | null>(null);
  const testMutation = useMutation(
    trpc.broadcasts.sendTest.mutationOptions({
      onSuccess: (result) =>
        setTestResult(
          result.hold
            ? {
                kind: "queued",
                domain: result.hold.kind === "domain_limit" ? result.hold.domain : null,
              }
            : { kind: "sent", to: result.to },
        ),
      onError: (error) =>
        setTestResult({
          kind: error.data?.code === "TOO_MANY_REQUESTS" ? "rateLimited" : "failed",
        }),
    }),
  );
  const sendTest = () => {
    setTestResult(null);
    testMutation.mutate({
      from: from.trim(),
      subject: subject.trim(),
      html: html.trim() ? html : null,
      text: text.trim() ? text : null,
      ...(replyTo.trim()
        ? {
            replyTo: replyTo
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          }
        : {}),
    });
  };

  const complete = from.trim() !== "" && subject.trim() !== "";
  const saving = createMutation.isPending || updateMutation.isPending;
  // `saving` as of the last render, for code that reads it after an await.
  savingNow.current = saving;
  const sending = saving || sendMutation.isPending;

  const invalidate = () => queryClient.invalidateQueries(trpc.broadcasts.pathFilter());

  /** Create-or-update the draft; returns its id. */
  async function persist(): Promise<string> {
    if (initial) {
      await updateMutation.mutateAsync({
        id: initial.id,
        topicId: topicId || null,
        segmentId: segmentId || null,
        ...(name.trim() ? { name: name.trim() } : { name: "" }),
        from: from.trim(),
        subject: subject.trim(),
        replyTo: replyTo.trim(),
        html,
        text,
        // Code mode keeps the row html-authored, whatever shape the state holds.
        document: mode === "code" ? null : document,
      });
      savedDoc.current = JSON.stringify(document);
      savedHtml.current = html;
      setDirty(false);
      // Saved: the row holds the html now, so the way back is the conversion.
      setBeforeSwitch(null);
      draft.markSaved();
      return initial.id;
    }
    const { id } = await createMutation.mutateAsync({
      ...(topicId ? { topicId } : {}),
      ...(segmentId ? { segmentId } : {}),
      ...(name.trim() ? { name: name.trim() } : {}),
      from: from.trim(),
      subject: subject.trim(),
      ...(replyTo.trim() ? { replyTo: replyTo.trim() } : {}),
      ...(html ? { html } : {}),
      ...(text ? { text } : {}),
      ...(document && mode !== "code" ? { document } : {}),
    });
    savedDoc.current = JSON.stringify(document);
    savedHtml.current = html;
    setDirty(false);
    setBeforeSwitch(null);
    draft.markSaved();
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
    // Mirrors the confirm button's disabled state (zero recipients, too large):
    // Modal's onConfirm shortcut routes here too and must obey the same guard.
    if (!complete || sending || sendBlocked) return;
    try {
      const id = await persist();
      await sendMutation.mutateAsync({
        id,
        ...(schedule ? { scheduledAt: new Date(schedule) } : {}),
        ...(enablesWarmup ? { warmup: true } : {}),
        ...(byWarmup && skipInactive !== undefined ? { skipInactive } : {}),
      });
      invalidate();
      router.push(`/broadcasts/${id}`);
    } catch {
      // Shown via the mutations' error state.
    }
  }

  const closeGuard = useCallback(() => setGuardOpen(false), []);
  const closeConvert = useCallback(() => setConvertOpen(false), []);
  const convertInPlace = useCallback(() => {
    setConvertOpen(false);
    setAsCode(false);
    setConverting(true);
    setBeforeSwitch(null);
    setTab("edit");
  }, []);

  // Blocks→html. The source is the server render of the current document,
  // fetched now rather than read from `html`, which lags a debounce and a
  // round trip behind the editor. An empty document switches on the spot —
  // there is nothing to lose and nothing to render; anything else goes
  // through the dialog, since the block document is dropped on the next save.
  const [switching, setSwitching] = useState<"inPlace" | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  // Set by a switch; the source takes focus once code mode has mounted it.
  const focusSource = useRef(false);
  useEffect(() => {
    if (!focusSource.current || mode !== "code" || tab !== "edit") return;
    focusSource.current = false;
    window.document.getElementById("bc-html")?.focus();
  }, [mode, tab]);
  // No block document yet (the editor has not emitted, or a conversion is
  // still parsing): the html on hand is the source already.
  const bodyEmpty = isMailyDoc(document) ? isEmptyMailyDoc(document) : html.trim() === "";
  async function renderCurrent(): Promise<{ html: string; text: string }> {
    if (!isMailyDoc(document)) return { html, text };
    if (isEmptyMailyDoc(document)) return { html: "", text: "" };
    // One attempt: the dialog reports a failure now, not after the retries.
    return queryClient.fetchQuery({
      ...trpc.email.render.queryOptions({ document }),
      retry: false,
    });
  }
  function enterCode(source: { html: string; text: string }) {
    if (isMailyDoc(document)) {
      setBeforeSwitch({
        document,
        html,
        text,
        switchedHtml: source.html,
        dirty,
      });
    }
    setHtml(source.html);
    setText(source.text);
    setDocument(null);
    setConverting(false);
    setAsCode(true);
    setTab("edit");
    focusSource.current = true;
    // Until the next save the row still holds a block document, so no html
    // can match it: poison the baseline, as a restored draft does.
    if (initial) {
      savedHtml.current = "__switched__";
      setDirty(true);
    }
  }
  function requestCode() {
    setSwitchError(null);
    if (bodyEmpty) enterCode({ html: "", text: "" });
    else setSwitchOpen(true);
  }
  async function switchInPlace() {
    setSwitching("inPlace");
    setSwitchError(null);
    try {
      const source = await renderCurrent();
      setSwitchOpen(false);
      enterCode(source);
    } catch {
      setSwitchError(tTemplates("html.switchError"));
    } finally {
      setSwitching(null);
    }
  }

  // Html→blocks while an in-place switch is unsaved: the blocks come back
  // exactly as they were. Edited html would be discarded, so that asks first.
  function requestBlocks() {
    if (!beforeSwitch) return;
    if (html === beforeSwitch.switchedHtml) backToBlocks();
    else setBackOpen(true);
  }
  function backToBlocks() {
    if (!beforeSwitch) return;
    setBackOpen(false);
    setDocument(beforeSwitch.document);
    setHtml(beforeSwitch.html);
    setText(beforeSwitch.text);
    setAsCode(false);
    setConverting(false);
    setTab("edit");
    setDirty(beforeSwitch.dirty);
    setBeforeSwitch(null);
  }
  // Source beside preview needs the room; every other body stays at reading width.
  const wideBody = mode === "code" && tab === "edit";

  const saveError = createMutation.isError || updateMutation.isError;
  // Server guards (deliverability pause, region breaker, unverified sender)
  // already carry a localized, specific message; only unknown failures get
  // the generic copy.
  const sendErrorMessage = sendMutation.isError
    ? sendMutation.error.message.includes("APP_BASE_URL")
      ? t("guard.appBaseUrl")
      : sendMutation.error.data?.code === "PRECONDITION_FAILED"
        ? sendMutation.error.message
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
            <div style={{ position: "relative" }}>
              <button
                type="button"
                className="ms-btn ms-btn-secondary"
                disabled={!complete || testMutation.isPending}
                onClick={sendTest}
              >
                <BtnSpinner on={testMutation.isPending} />
                {t("composer.sendTest")}
              </button>
              {testResult ? <TestSendNote result={testResult} /> : null}
            </div>
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
                setPace("warmup");
                setSkipInactive(undefined);
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
              setStep(2);
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

            {(segments.data?.length ?? 0) > 0 ? (
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
                    ...(segments.data ?? []).map((segment) => ({
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
              <button type="submit" className="ms-btn ms-btn-primary">
                {t("composer.continue")}
              </button>
            </div>
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
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                {/* "Change" drops under the recap before the recap gets narrower than this. */}
                <div style={{ flex: "1 1 220px", minWidth: 0 }}>
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
                    {selectedSegment?.name ?? t("composer.segmentNone")}{" "}
                    <span style={{ color: "var(--ms-success)", fontWeight: 400 }}>✓</span>
                    {name.trim() ? (
                      <span style={{ color: "var(--ms-muted)", fontWeight: 400 }}>
                        {" "}
                        · {name.trim()}
                      </span>
                    ) : null}
                  </div>
                  {selectedTopic ? (
                    <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--ms-muted)" }}>
                      {t("composer.topicLabel")}: {selectedTopic.name}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="ms-btn ms-btn-secondary"
                  style={{ marginLeft: "auto" }}
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
                maxWidth: wideBody ? 1200 : 720,
              }}
            >
              {templateOptions.length > 0 ? (
                <div className="ms-field">
                  <label htmlFor="bc-template">{tTemplates("picker.label")}</label>
                  <Select
                    id="bc-template"
                    value={templateId}
                    onChange={(value) => void applyTemplate(value)}
                    disabled={saving}
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

              <FromField key={editorNonce} id="bc-from" value={from} onChange={setFrom} />

              <div className="ms-tpl-meta" style={{ gap: 10 }}>
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
                {/* Wraps rather than squeezing the tabs on a phone, longer locales included. */}
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "6px 12px",
                    marginBottom: 6,
                  }}
                >
                  <label htmlFor="bc-html" style={{ marginBottom: 0 }}>
                    {t("composer.htmlLabel")}
                  </label>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      justifyContent: "flex-end",
                      gap: "6px 12px",
                      marginLeft: "auto",
                    }}
                  >
                    {mode === "blocks" || beforeSwitch ? (
                      // Off while saving: the save in flight resets the baselines
                      // for the body it sent, whichever mode the page is in by then.
                      // The banner's Convert and the template picker are off too.
                      <button
                        type="button"
                        className="ms-maily-tool ms-maily-tool-labeled"
                        disabled={saving}
                        onClick={mode === "blocks" ? requestCode : requestBlocks}
                      >
                        {mode === "blocks" ? <CodeGlyph size={14} /> : null}
                        {tTemplates(mode === "blocks" ? "html.editAsHtml" : "html.backToBlocks")}
                      </button>
                    ) : null}
                    <span style={{ display: "flex", gap: 6 }}>
                      {(["edit", "preview"] as const).map((key) => (
                        <button
                          key={key}
                          type="button"
                          style={{
                            font: "inherit",
                            fontSize: 13,
                            padding: "4px 10px",
                            borderRadius: 8,
                            border: 0,
                            cursor: "pointer",
                            background: tab === key ? "var(--ms-panel-raised)" : "none",
                            color: tab === key ? "var(--ms-bone)" : "var(--ms-muted)",
                            whiteSpace: "nowrap",
                          }}
                          onClick={() => setTab(key)}
                        >
                          {t(key === "edit" ? "composer.editTab" : "composer.previewTab")}
                        </button>
                      ))}
                    </span>
                  </div>
                </div>
                {tab === "edit" && mode === "blocks" ? (
                  <MailyEditor
                    key={`${templateId}:${editorNonce}`}
                    value={{ document, html }}
                    convertHtml={converting}
                    onChange={(v) => {
                      setDocument(v.document);
                      const snapshot = JSON.stringify(v.document);
                      // First emit of a brand-new document is the baseline, not an edit.
                      if (savedDoc.current === null) savedDoc.current = snapshot;
                      else if (snapshot !== savedDoc.current) setDirty(true);
                    }}
                    mergeFields={mergeFields}
                  />
                ) : tab === "edit" ? (
                  <HtmlCodeMode
                    id="bc-html"
                    html={html}
                    onChange={(next) => {
                      setText(followingText(text, html, next));
                      setHtml(next);
                      setDirty(next !== savedHtml.current);
                    }}
                    mergeFields={mergeFields}
                    previewSamples={previewSamples}
                    text={text}
                  />
                ) : (
                  <>
                    {mode === "code" ? (
                      <HtmlAuthoredBanner
                        onEditHtml={() => setTab("edit")}
                        onConvert={() => setConvertOpen(true)}
                        convertDisabled={saving}
                      />
                    ) : null}
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
                  </>
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

              {saveError && !guardOpen ? (
                <p className="ms-field-error" style={{ margin: 0 }}>
                  {t("composer.saveError")}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      )}

      <Modal
        open={guardOpen}
        onClose={closeGuard}
        onConfirm={() => void confirmSend()}
        title={t("guard.title")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void confirmSend();
          }}
        >
          {sendPlan.data ? (
            <SendPlanSummary
              count={sendPlan.data.count}
              estimate={sendPlan.data.estimate}
              cloud={sendPlan.data.cloud}
              locale={locale}
              warmup={warmup}
              pace={pace}
              onPace={setPace}
              onSkipInactive={setSkipInactive}
              scheduled={schedule !== ""}
            />
          ) : (
            <p
              style={{ margin: "0 0 18px", fontSize: "var(--ms-fs-ui)", color: "var(--ms-muted)" }}
            >
              {t("guard.counting")}
            </p>
          )}
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
          {sendErrorMessage ? <p className="ms-field-error">{sendErrorMessage}</p> : null}
          <ModalFooter>
            <button type="button" className="ms-btn ms-btn-secondary" onClick={closeGuard}>
              {common("cancel")} <span className="ms-keycap">Esc</span>
            </button>
            <button
              type="submit"
              className="ms-btn ms-btn-primary"
              disabled={sending || sendBlocked}
            >
              <BtnSpinner on={sending} />
              {enablesWarmup
                ? t("guard.sendWithWarmup")
                : schedule
                  ? t("guard.schedule")
                  : t("guard.sendNow")}{" "}
              <ConfirmKeycap />
            </button>
          </ModalFooter>
        </form>
      </Modal>

      <SwitchHtmlDialog
        open={switchOpen}
        pending={switching}
        error={switchError}
        body={t("composer.switchBody")}
        inPlaceLabel={t("composer.convertInPlace")}
        onClose={() => setSwitchOpen(false)}
        onSwitchInPlace={switchInPlace}
      />
      <BackToBlocksDialog
        open={backOpen}
        onClose={() => setBackOpen(false)}
        onConfirm={backToBlocks}
      />
      <ConvertBlocksDialog
        open={convertOpen}
        onClose={closeConvert}
        onConvertInPlace={convertInPlace}
        inPlaceLabel={t("composer.convertInPlace")}
      />
    </>
  );
}
