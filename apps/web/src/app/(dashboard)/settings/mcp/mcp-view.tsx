"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { CodeHighlight, type HighlightLanguage } from "@/components/code-highlight";
import { CopyChip, CopyGlyph } from "@/components/copy-chip";
import { Table } from "@/components/table";
import { codeRichTags } from "@/lib/code-rich-tags";
import { MCP_TOOLS } from "./mcp-tools";

const MCP_DOCS_URL = "https://docs.millionsend.com/mcp";

/* Client names are product names, not translatable copy. */
const CLIENTS = ["claudeCode", "claudeDesktop", "cursor", "vscode"] as const;
type Client = (typeof CLIENTS)[number];
const CLIENT_LABELS: Record<Client, string> = {
  claudeCode: "Claude Code",
  claudeDesktop: "Claude Desktop",
  cursor: "Cursor",
  vscode: "VS Code",
};

function clientSnippet(client: Client, url: string): { code: string; language: HighlightLanguage } {
  switch (client) {
    case "claudeCode":
      return { code: `claude mcp add --transport http millionsend ${url}`, language: "bash" };
    // Claude Desktop's config file only launches stdio servers; mcp-remote
    // bridges it to the Streamable HTTP endpoint.
    case "claudeDesktop":
      return {
        code: `{
  "mcpServers": {
    "millionsend": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${url}"]
    }
  }
}`,
        language: "json",
      };
    case "cursor":
      return {
        code: `{
  "mcpServers": {
    "millionsend": {
      "url": "${url}"
    }
  }
}`,
        language: "json",
      };
    case "vscode":
      return {
        code: `{
  "servers": {
    "millionsend": {
      "type": "http",
      "url": "${url}"
    }
  }
}`,
        language: "json",
      };
  }
}

function SnippetBlock({ code, language }: { code: string; language: HighlightLanguage }) {
  return (
    <div style={{ position: "relative" }}>
      <pre
        className="ms-mono ms-hl"
        style={{
          margin: 0,
          padding: "14px 40px 14px 16px",
          background: "var(--ms-inset)",
          border: "1px solid var(--ms-line)",
          borderRadius: 10,
          fontSize: 12,
          lineHeight: 1.65,
          color: "var(--ms-bone)",
          overflowX: "auto",
        }}
      >
        <CodeHighlight code={code} language={language} />
      </pre>
      <span style={{ position: "absolute", top: 10, right: 12 }}>
        <CopyGlyph value={code} />
      </span>
    </div>
  );
}

export function McpView({ serverUrl }: { serverUrl: string }) {
  const t = useTranslations("settings.mcp");
  const scopeT = useTranslations("auth.consent.scopes");
  const [client, setClient] = useState<Client>("claudeCode");
  const snippet = clientSnippet(client, serverUrl);

  return (
    <div style={{ maxWidth: 720, display: "grid", gap: 20 }}>
      <section className="ms-card" style={{ padding: 24 }}>
        <p style={{ margin: "0 0 4px", fontSize: 14, color: "var(--ms-bone)" }}>{t("intro")}</p>
        <p style={{ margin: "0 0 18px", fontSize: 13, color: "var(--ms-muted)" }}>
          {t("subtitle")}
        </p>
        <div className="ms-microlabel" style={{ marginBottom: 6 }}>
          {t("serverUrl")}
        </div>
        <CopyChip value={serverUrl} />
        <p style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--ms-muted)" }}>
          {t("serverUrlNote")}
        </p>
      </section>

      <section className="ms-card" style={{ padding: 24 }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600, color: "var(--ms-bone)" }}>
          {t("connectTitle")}
        </h2>
        <div className="ms-tabs" style={{ marginBottom: 14 }}>
          {CLIENTS.map((key) => (
            <button
              key={key}
              type="button"
              className={key === client ? "active" : ""}
              onClick={() => setClient(key)}
            >
              {CLIENT_LABELS[key]}
            </button>
          ))}
        </div>
        <SnippetBlock code={snippet.code} language={snippet.language} />
        <p style={{ margin: "10px 0 0", fontSize: 12.5, color: "var(--ms-muted)" }}>
          {t.rich(`notes.${client}`, codeRichTags)}
        </p>
        <p
          style={{ margin: "14px 0 0", fontSize: 12.5, color: "var(--ms-muted)", lineHeight: 1.6 }}
        >
          {t.rich("authNote", {
            ...codeRichTags,
            link: (chunks) => <Link href="/settings/connected-apps">{chunks}</Link>,
          })}
        </p>
      </section>

      <section className="ms-card" style={{ padding: 24 }}>
        <h2 style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 600, color: "var(--ms-bone)" }}>
          {t("toolsTitle")}
        </h2>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--ms-muted)" }}>
          {t("toolsIntro")}
        </p>
        <Table>
          <thead>
            <tr>
              <th>{t("table.tool")}</th>
              <th>{t("table.permission")}</th>
            </tr>
          </thead>
          <tbody>
            {MCP_TOOLS.map((tool) => (
              <tr key={tool.name}>
                <td className="ms-mono" style={{ fontSize: 12.5 }}>
                  {tool.name}
                  {tool.readOnly ? (
                    <span className="ms-badge ms-badge-neutral" style={{ marginLeft: 8 }}>
                      {t("readOnly")}
                    </span>
                  ) : null}
                </td>
                <td>
                  <span className="ms-mono" style={{ fontSize: 12 }}>
                    {tool.scope}
                  </span>
                  <span style={{ marginLeft: 8, fontSize: 12, color: "var(--ms-muted)" }}>
                    {scopeT(tool.scope.replace(":", "_"))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p style={{ margin: "16px 0 0", fontSize: 13, color: "var(--ms-muted)" }}>
          <a href={MCP_DOCS_URL} target="_blank" rel="noreferrer">
            {t("docs")} ↗
          </a>
        </p>
      </section>
    </div>
  );
}
