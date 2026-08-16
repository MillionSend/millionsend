"use client";

import { useTranslations } from "next-intl";
import { can, chain, type TiptapEditor } from "./commands";
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BoldIcon,
  BulletListIcon,
  ClearFormatIcon,
  H1Icon,
  H2Icon,
  ItalicIcon,
  OrderedListIcon,
  StrikeIcon,
  UnderlineIcon,
} from "./icons";
import { LinkControl } from "./link-control";
import { type PickerField, VariablePicker } from "./variable-picker";

export type { TiptapEditor } from "./commands";

function ToolButton({
  onClick,
  active = false,
  disabled = false,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="ms-maily-tool"
      data-active={active || undefined}
      disabled={disabled}
      aria-label={title}
      aria-pressed={active}
      title={title}
      // Keep focus in the document so the command applies to the selection.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span className="ms-maily-sep" aria-hidden="true" />;
}

export function EditorToolbar({
  editor,
  fields,
}: {
  editor: TiptapEditor | null;
  fields: PickerField[];
}) {
  const t = useTranslations("block-editor");
  const off = !editor;

  const insertVariable = (name: string, label: string, fallback: string | null) => {
    if (!editor) return;
    chain(editor)
      .focus()
      .insertContent([
        { type: "variable", attrs: { id: name, label, ...(fallback ? { fallback } : {}) } },
        { type: "text", text: " " },
      ])
      .run();
  };

  return (
    <div className="ms-maily-toolbar" role="toolbar" aria-label={t("toolbar.formatting")}>
      <ToolButton
        title={t("panel.bold")}
        disabled={off}
        active={!!editor?.isActive("bold")}
        onClick={() => editor && chain(editor).focus().toggleBold().run()}
      >
        <BoldIcon />
      </ToolButton>
      <ToolButton
        title={t("panel.italic")}
        disabled={off}
        active={!!editor?.isActive("italic")}
        onClick={() => editor && chain(editor).focus().toggleItalic().run()}
      >
        <ItalicIcon />
      </ToolButton>
      <ToolButton
        title={t("panel.underline")}
        disabled={off}
        active={!!editor?.isActive("underline")}
        onClick={() => editor && chain(editor).focus().toggleUnderline().run()}
      >
        <UnderlineIcon />
      </ToolButton>
      <ToolButton
        title={t("panel.strike")}
        disabled={off}
        active={!!editor?.isActive("strike")}
        onClick={() => editor && chain(editor).focus().toggleStrike().run()}
      >
        <StrikeIcon />
      </ToolButton>

      <Sep />

      <ToolButton
        title={t("toolbar.h1")}
        disabled={off || !(editor && can(editor).toggleHeading({ level: 1 }))}
        active={!!editor?.isActive("heading", { level: 1 })}
        onClick={() => editor && chain(editor).focus().toggleHeading({ level: 1 }).run()}
      >
        <H1Icon />
      </ToolButton>
      <ToolButton
        title={t("toolbar.h2")}
        disabled={off || !(editor && can(editor).toggleHeading({ level: 2 }))}
        active={!!editor?.isActive("heading", { level: 2 })}
        onClick={() => editor && chain(editor).focus().toggleHeading({ level: 2 }).run()}
      >
        <H2Icon />
      </ToolButton>

      <Sep />

      <ToolButton
        title={t("toolbar.bulletList")}
        disabled={off || !(editor && can(editor).toggleBulletList())}
        active={!!editor?.isActive("bulletList")}
        onClick={() => editor && chain(editor).focus().toggleBulletList().run()}
      >
        <BulletListIcon />
      </ToolButton>
      <ToolButton
        title={t("toolbar.orderedList")}
        disabled={off || !(editor && can(editor).toggleOrderedList())}
        active={!!editor?.isActive("orderedList")}
        onClick={() => editor && chain(editor).focus().toggleOrderedList().run()}
      >
        <OrderedListIcon />
      </ToolButton>

      <Sep />

      <ToolButton
        title={t("toolbar.alignLeft")}
        disabled={off}
        active={!!editor?.isActive({ textAlign: "left" })}
        onClick={() => editor && chain(editor).focus().setTextAlign("left").run()}
      >
        <AlignLeftIcon />
      </ToolButton>
      <ToolButton
        title={t("toolbar.alignCenter")}
        disabled={off}
        active={!!editor?.isActive({ textAlign: "center" })}
        onClick={() => editor && chain(editor).focus().setTextAlign("center").run()}
      >
        <AlignCenterIcon />
      </ToolButton>
      <ToolButton
        title={t("toolbar.alignRight")}
        disabled={off}
        active={!!editor?.isActive({ textAlign: "right" })}
        onClick={() => editor && chain(editor).focus().setTextAlign("right").run()}
      >
        <AlignRightIcon />
      </ToolButton>

      <Sep />

      <LinkControl editor={editor} />
      <ToolButton
        title={t("toolbar.clear")}
        disabled={off}
        onClick={() => editor && chain(editor).focus().unsetAllMarks().clearNodes().run()}
      >
        <ClearFormatIcon />
      </ToolButton>

      <span className="ms-maily-toolbar-spacer" />

      <VariablePicker fields={fields} onInsert={insertVariable} />
    </div>
  );
}
