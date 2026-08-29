"use client";

import { useLocale } from "next-intl";
import {
  UnsubscribePageView,
  type UnsubscribeViewCustomization,
  type UnsubscribeViewState,
  type UnsubscribeViewTopic,
} from "@/app/unsubscribe/page-view";
import en from "../../messages/en/unsubscribe.json";
import ptBR from "../../messages/pt-BR/unsubscribe.json";

/** topics.list rows → the page's preferences list: public topics only, each
 * defaulting to its opt-in state, oldest-first as the hosted page orders them
 * (the list query is newest-first). */
export function toPreviewTopics(
  topics: { id: string; name: string; defaultSubscribed: boolean; visibility: string }[],
): UnsubscribeViewTopic[] {
  return topics
    .filter((topic) => topic.visibility === "public")
    .map((topic) => ({ id: topic.id, name: topic.name, subscribed: topic.defaultSubscribed }))
    .reverse();
}

/**
 * Scaled-down, inert live render of the hosted unsubscribe page — the one
 * preview frame, shared by the settings editor and the topics tab. The
 * recipient-facing catalog is picked by the dashboard locale (the public page
 * itself uses Accept-Language).
 */
export function UnsubscribePreview({
  state = "confirm",
  topics,
  customization,
}: {
  state?: UnsubscribeViewState;
  topics: UnsubscribeViewTopic[];
  customization: UnsubscribeViewCustomization;
}) {
  const locale = useLocale();
  const m = locale.startsWith("pt") ? ptBR : en;
  return (
    <div
      style={{
        border: "1px solid var(--ms-line)",
        borderRadius: "var(--ms-r-card)",
        overflow: "hidden",
        height: 420,
        background: "var(--ms-void)",
      }}
    >
      {/* inert: the preview renders the page's real forms; nothing may submit. */}
      {/* scale × minHeight = the frame's 420px, so the page centers exactly. */}
      <div inert style={{ transform: "scale(0.8)", transformOrigin: "top left", width: "125%" }}>
        <UnsubscribePageView
          m={m}
          state={state}
          topics={topics}
          minHeight={525}
          customization={customization}
        />
      </div>
    </div>
  );
}
