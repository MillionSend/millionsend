"use client";

import bash from "highlight.js/lib/languages/bash";
import csharp from "highlight.js/lib/languages/csharp";
import elixir from "highlight.js/lib/languages/elixir";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import { createLowlight } from "lowlight";
import type { ReactNode } from "react";

/** Only the grammars the SDK snippets need — registering all of hljs would
 *  drag every language into the client bundle. */
const lowlight = createLowlight({
  bash,
  javascript,
  python,
  php,
  ruby,
  go,
  rust,
  java,
  csharp,
  elixir,
});

export type HighlightLanguage =
  | "bash"
  | "javascript"
  | "python"
  | "php"
  | "ruby"
  | "go"
  | "rust"
  | "java"
  | "csharp"
  | "elixir";

/** Structural subset of the hast tree lowlight returns. */
interface HastNode {
  type: string;
  value?: string;
  properties?: { className?: string[] };
  children?: HastNode[];
}

function renderNodes(nodes: HastNode[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.type === "text") return node.value;
    if (node.type === "element") {
      const key = `${keyPrefix}-${index}`;
      return (
        <span key={key} className={(node.properties?.className ?? []).join(" ")}>
          {renderNodes(node.children ?? [], key)}
        </span>
      );
    }
    return null;
  });
}

/**
 * Syntax-highlighted code as React spans carrying hljs class names — the
 * palette lives in components.css under .ms-hl, on the design tokens.
 */
export function CodeHighlight({ code, language }: { code: string; language: HighlightLanguage }) {
  const tree = lowlight.highlight(language, code) as unknown as { children: HastNode[] };
  return <>{renderNodes(tree.children, "hl")}</>;
}
