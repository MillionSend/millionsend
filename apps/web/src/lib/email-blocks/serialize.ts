import { escapeHtml, htmlToText } from "../html";
import type { Block, BlockDoc } from "./model";

/**
 * Renders a BlockDoc to the inline-styled table HTML email clients accept
 * (they strip <style> and ignore flexbox) plus a plain-text derivation. Each
 * block is one row of a 600px centered container. Author `html` fields pass
 * through byte-for-byte — merge tokens ({{{NAME}}}) included — so substitution
 * happens later in the send pipeline. Only author-typed scalars (labels, alt,
 * colors, URLs) are escaped, as defense in depth against a stray quote or
 * angle bracket breaking out of an attribute.
 */

const FONT =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";

function renderBlock(block: Block): string {
  switch (block.type) {
    case "heading":
      return `<tr><td align="${block.align}" style="padding:${block.padding}px;"><h${block.level} style="margin:0;${FONT}font-size:${block.fontSize}px;font-weight:bold;color:${escapeHtml(block.color)};line-height:1.3;">${block.html}</h${block.level}></td></tr>`;
    case "text":
      return `<tr><td align="${block.align}" style="padding:${block.padding}px;${FONT}font-size:${block.fontSize}px;color:${escapeHtml(block.color)};line-height:1.5;">${block.html}</td></tr>`;
    case "image": {
      const img = `<img src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt)}" width="${block.width}" style="display:block;border:0;outline:none;text-decoration:none;width:${block.width}px;max-width:100%;height:auto;"/>`;
      const inner = block.href
        ? `<a href="${escapeHtml(block.href)}" target="_blank">${img}</a>`
        : img;
      return `<tr><td align="${block.align}" style="padding:${block.padding}px;">${inner}</td></tr>`;
    }
    case "button":
      return `<tr><td align="${block.align}" style="padding:${block.padding}px;"><table role="presentation" border="0" cellspacing="0" cellpadding="0" style="border-collapse:separate;"><tr><td align="center" bgcolor="${escapeHtml(block.bgColor)}" style="background-color:${escapeHtml(block.bgColor)};border-radius:${block.radius}px;"><a href="${escapeHtml(block.href)}" target="_blank" style="display:inline-block;padding:12px 24px;${FONT}font-size:16px;font-weight:bold;color:${escapeHtml(block.textColor)};text-decoration:none;border-radius:${block.radius}px;">${escapeHtml(block.label)}</a></td></tr></table></td></tr>`;
    case "divider":
      return `<tr><td style="padding:${block.padding}px;"><hr style="border:0;border-top:${block.thickness}px solid ${escapeHtml(block.color)};margin:0;width:100%;"/></td></tr>`;
    case "spacer":
      return `<tr><td style="height:${block.height}px;line-height:${block.height}px;font-size:0;">&nbsp;</td></tr>`;
    case "html":
      return `<tr><td style="padding:${block.padding}px;">${block.html}</td></tr>`;
  }
}

function blockText(block: Block): string {
  switch (block.type) {
    case "heading":
    case "text":
    case "html":
      return htmlToText(block.html);
    case "image":
      if (block.alt) return block.href ? `${block.alt} (${block.href})` : block.alt;
      return block.href ?? "";
    case "button":
      return `${block.label} (${block.href})`;
    case "divider":
    case "spacer":
      return "";
  }
}

export function serialize(doc: BlockDoc): { html: string; text: string } {
  const rows = doc.blocks.map(renderBlock).join("");
  const html =
    `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="width:100%;background-color:#ffffff;">` +
    `<tr><td align="center" style="padding:0;">` +
    `<table role="presentation" width="600" border="0" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;margin:0 auto;">` +
    `${rows}</table></td></tr></table>`;
  const text = doc.blocks
    .map(blockText)
    .filter((line) => line !== "")
    .join("\n\n")
    .trim();
  return { html, text };
}
