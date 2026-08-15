import type { Editor } from "@tiptap/react";
import { useTranslations } from "next-intl";
import type { Align, Block } from "@/lib/email-blocks/model";
import { sanitizeHtml } from "@/lib/sanitize-html";

/**
 * Contextual style controls for the selected block. Text/heading colour,
 * font-size and align live here alongside inline-mark toggles that act on the
 * block's live tiptap editor; the other block types expose their own fields.
 * Letter-spacing and a page-level panel are deferred.
 */
export function StylePanel({
  block,
  editor,
  onChange,
}: {
  block: Block;
  editor: Editor | null;
  onChange: (patch: Partial<Block>) => void;
}) {
  const t = useTranslations("block-editor");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div
        style={{
          fontSize: "var(--ms-fs-label)",
          color: "var(--ms-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        {t(`block.${block.type}`)}
      </div>

      {block.type === "heading" ? (
        <Row label={t("panel.level")}>
          <Segmented
            options={[
              { value: "1", label: "H1" },
              { value: "2", label: "H2" },
              { value: "3", label: "H3" },
            ]}
            value={String(block.level)}
            onChange={(v) => onChange({ level: Number(v) as 1 | 2 | 3 })}
          />
        </Row>
      ) : null}

      {block.type === "heading" || block.type === "text" ? (
        <>
          <MarkBar editor={editor} t={t} />
          <Row label={t("panel.color")}>
            <ColorInput value={block.color} onChange={(color) => onChange({ color })} />
          </Row>
          <Row label={t("panel.fontSize")}>
            <NumberInput value={block.fontSize} onChange={(fontSize) => onChange({ fontSize })} />
          </Row>
          <Row label={t("panel.align")}>
            <AlignInput value={block.align} onChange={(align) => onChange({ align })} />
          </Row>
        </>
      ) : null}

      {block.type === "button" ? (
        <>
          <Row label={t("panel.label")}>
            <TextInput value={block.label} onChange={(label) => onChange({ label })} />
          </Row>
          <Row label={t("panel.href")}>
            <TextInput value={block.href} onChange={(href) => onChange({ href })} />
          </Row>
          <Row label={t("panel.bgColor")}>
            <ColorInput value={block.bgColor} onChange={(bgColor) => onChange({ bgColor })} />
          </Row>
          <Row label={t("panel.textColor")}>
            <ColorInput value={block.textColor} onChange={(textColor) => onChange({ textColor })} />
          </Row>
          <Row label={t("panel.radius")}>
            <NumberInput value={block.radius} onChange={(radius) => onChange({ radius })} />
          </Row>
          <Row label={t("panel.align")}>
            <AlignInput value={block.align} onChange={(align) => onChange({ align })} />
          </Row>
        </>
      ) : null}

      {block.type === "image" ? (
        <>
          <Row label={t("panel.src")}>
            <TextInput value={block.src} onChange={(src) => onChange({ src: sanitizeUrl(src) })} />
          </Row>
          <Row label={t("panel.alt")}>
            <TextInput value={block.alt} onChange={(alt) => onChange({ alt })} />
          </Row>
          <Row label={t("panel.width")}>
            <NumberInput value={block.width} onChange={(width) => onChange({ width })} />
          </Row>
          <Row label={t("panel.link")}>
            <TextInput value={block.href ?? ""} onChange={(href) => onChange({ href })} />
          </Row>
          <Row label={t("panel.align")}>
            <AlignInput value={block.align} onChange={(align) => onChange({ align })} />
          </Row>
        </>
      ) : null}

      {block.type === "divider" ? (
        <>
          <Row label={t("panel.color")}>
            <ColorInput value={block.color} onChange={(color) => onChange({ color })} />
          </Row>
          <Row label={t("panel.thickness")}>
            <NumberInput
              value={block.thickness}
              onChange={(thickness) => onChange({ thickness })}
            />
          </Row>
        </>
      ) : null}

      {block.type === "spacer" ? (
        <Row label={t("panel.height")}>
          <NumberInput value={block.height} onChange={(height) => onChange({ height })} />
        </Row>
      ) : null}

      {block.type === "html" ? (
        <Row label={t("panel.customHtml")}>
          <textarea
            className="ms-input ms-mono"
            style={{ width: "100%", minHeight: 160, resize: "vertical", lineHeight: 1.5 }}
            value={block.html}
            onChange={(e) => onChange({ html: sanitizeHtml(e.target.value) })}
          />
        </Row>
      ) : null}

      {block.type !== "spacer" ? (
        <Row label={t("panel.padding")}>
          <NumberInput value={block.padding} onChange={(padding) => onChange({ padding })} />
        </Row>
      ) : null}
    </div>
  );
}

/** javascript:/data: image sources have no place in an email; keep http(s) and empty. */
function sanitizeUrl(url: string): string {
  return /^\s*(javascript|data|vbscript):/i.test(url) ? "" : url;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="ms-field">
      <span
        style={{
          display: "block",
          fontSize: "var(--ms-fs-label)",
          color: "var(--ms-muted)",
          marginBottom: 6,
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function TextInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      className="ms-input"
      style={{ width: "100%" }}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function NumberInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <input
      className="ms-input"
      type="number"
      style={{ width: "100%" }}
      value={value}
      onChange={(e) => onChange(Number(e.target.value) || 0)}
    />
  );
}

function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: 34, height: 30, padding: 0, border: 0, background: "none" }}
      />
      <input
        className="ms-input ms-mono"
        style={{ flex: 1 }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </span>
  );
}

function AlignInput({ value, onChange }: { value: Align; onChange: (v: Align) => void }) {
  return (
    <Segmented
      options={[
        { value: "left", label: "◧" },
        { value: "center", label: "▣" },
        { value: "right", label: "◨" },
      ]}
      value={value}
      onChange={(v) => onChange(v as Align)}
    />
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        gap: 2,
        background: "var(--ms-inset)",
        padding: 2,
        borderRadius: "var(--ms-r-input)",
      }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className="ms-btn"
          style={{
            height: 26,
            padding: "0 10px",
            background: value === o.value ? "var(--ms-panel-raised)" : "transparent",
            color: value === o.value ? "var(--ms-bone)" : "var(--ms-muted)",
            border: 0,
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function MarkBar({ editor, t }: { editor: Editor | null; t: (k: string) => string }) {
  const marks: { key: string; label: string; run: () => void }[] = [
    { key: "bold", label: "B", run: () => editor?.chain().focus().toggleBold().run() },
    { key: "italic", label: "I", run: () => editor?.chain().focus().toggleItalic().run() },
    { key: "underline", label: "U", run: () => editor?.chain().focus().toggleUnderline().run() },
    { key: "strike", label: "S", run: () => editor?.chain().focus().toggleStrike().run() },
    {
      key: "link",
      label: "🔗",
      run: () => {
        const url = window.prompt(t("panel.linkPrompt")) ?? "";
        if (url === "") editor?.chain().focus().unsetLink().run();
        else
          editor
            ?.chain()
            .focus()
            .setLink({ href: sanitizeUrl(url) })
            .run();
      },
    },
  ];
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {marks.map((m) => (
        <button
          key={m.key}
          type="button"
          className="ms-btn ms-btn-icon"
          aria-label={t(`panel.${m.key}`)}
          disabled={!editor}
          onMouseDown={(e) => {
            e.preventDefault();
            m.run();
          }}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
