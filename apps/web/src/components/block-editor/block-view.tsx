import { useTranslations } from "next-intl";
import type { Block } from "@/lib/email-blocks/model";
import { sanitizeHtml } from "@/lib/sanitize-html";

/**
 * Read-only canvas preview for the non-text block types (text and heading blocks
 * render their own tiptap editor). Editing happens in the style panel; this only
 * shows what the block will look like. The custom-html block is sanitized before
 * preview as defense in depth.
 */
export function BlockView({
  block,
}: {
  block: Exclude<Block, { type: "heading" } | { type: "text" }>;
}) {
  const t = useTranslations("block-editor");
  switch (block.type) {
    case "image":
      return (
        <div style={{ textAlign: block.align, padding: block.padding }}>
          {block.src ? (
            // biome-ignore lint/performance/noImgElement: canvas preview mirrors the email's raw <img>, not a page asset
            <img
              src={block.src}
              alt={block.alt}
              style={{ width: block.width, maxWidth: "100%", height: "auto" }}
            />
          ) : (
            <div
              style={{
                border: "1px dashed var(--ms-line-strong)",
                borderRadius: "var(--ms-r-input)",
                padding: "28px 0",
                color: "var(--ms-faint)",
                fontSize: "var(--ms-fs-label)",
              }}
            >
              {t("view.imagePlaceholder")}
            </div>
          )}
        </div>
      );
    case "button":
      return (
        <div style={{ textAlign: block.align, padding: block.padding }}>
          <span
            style={{
              display: "inline-block",
              padding: "12px 24px",
              borderRadius: block.radius,
              background: block.bgColor,
              color: block.textColor,
              fontSize: 16,
              fontWeight: 600,
            }}
          >
            {block.label}
          </span>
        </div>
      );
    case "divider":
      return (
        <div style={{ padding: block.padding }}>
          <hr
            style={{ border: 0, borderTop: `${block.thickness}px solid ${block.color}`, margin: 0 }}
          />
        </div>
      );
    case "spacer":
      return (
        <div
          style={{
            height: block.height,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--ms-faint)",
            fontSize: "var(--ms-fs-micro)",
            border: "1px dashed var(--ms-line)",
          }}
        >
          {t("view.spacer", { h: block.height })}
        </div>
      );
    case "html":
      return (
        <div style={{ padding: block.padding }}>
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: author-supplied email markup, sanitized on entry and again here */}
          <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(block.html) }} />
        </div>
      );
  }
}
