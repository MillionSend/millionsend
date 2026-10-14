"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/skeleton";
import type { MergeFieldOption } from "@/lib/merge-fields";
import type { MailyEditorCompact, MailyEditorProps } from "./index";

// Client-only: the Maily editor pulls in tiptap and touches the DOM, so it
// must not render on the server. The ghost holds the field's height meanwhile.

/** The email design editor (broadcasts, templates). */
export const MailyEditor = dynamic(() => import("./index").then((m) => m.default), {
  ssr: false,
  loading: () => <Skeleton width="100%" height={340} radius="var(--ms-r-input)" />,
});

// The compact toolbar (43px) over the 120px body and its two borders.
const CompactEditor = dynamic(() => import("./index").then((m) => m.default), {
  ssr: false,
  loading: () => <Skeleton width="100%" height={165} radius="var(--ms-r-input)" />,
});

const NO_MERGE_FIELDS: MergeFieldOption[] = [];

/** The same editor for a message body (a reply, a new email): see MailyEditorCompact. */
export function MessageEditor(
  props: Pick<MailyEditorProps, "value" | "onChange"> & { compact: MailyEditorCompact },
) {
  return <CompactEditor {...props} mergeFields={NO_MERGE_FIELDS} />;
}
