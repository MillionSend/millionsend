import type { McpScope } from "@millionsend/core";

/* Mirror of the tool registry in apps/api/src/mcp.ts — the API is the
   source of truth; test/mcp-tools-sync.test.ts fails when they drift. */
export const MCP_TOOLS: { name: string; scope: McpScope; readOnly?: boolean }[] = [
  { name: "list_emails", scope: "emails:read", readOnly: true },
  { name: "get_email", scope: "emails:read", readOnly: true },
  { name: "list_contacts", scope: "audience:read", readOnly: true },
  { name: "get_contact", scope: "audience:read", readOnly: true },
  { name: "list_segments", scope: "audience:read", readOnly: true },
  { name: "list_topics", scope: "audience:read", readOnly: true },
  { name: "list_domains", scope: "domains:read", readOnly: true },
  { name: "send_email", scope: "emails:send" },
  { name: "create_contact", scope: "audience:write" },
  { name: "update_contact", scope: "audience:write" },
  { name: "add_contact_to_segment", scope: "audience:write" },
  { name: "create_broadcast", scope: "broadcasts:write" },
  { name: "send_broadcast", scope: "broadcasts:write" },
];
