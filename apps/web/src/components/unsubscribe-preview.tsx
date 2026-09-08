"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import {
  UnsubscribePageView,
  type UnsubscribeViewCustomization,
  type UnsubscribeViewState,
  type UnsubscribeViewTopic,
} from "@/app/unsubscribe/page-view";
import { Select } from "@/components/select";
import {
  pickUnsubscribeLocale,
  UNSUBSCRIBE_LOCALES,
  type UnsubscribeLocale,
} from "@/lib/unsubscribe-locales";

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
 * preview frame, shared by the settings editor and the topics tab. It opens
 * in the dashboard's language and switches to any the page speaks (the
 * public page itself picks from Accept-Language).
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
  const t = useTranslations("settings.unsubscribe");
  const dashboardLocale = useLocale();
  const [locale, setLocale] = useState<UnsubscribeLocale>(() =>
    pickUnsubscribeLocale(dashboardLocale),
  );
  return (
    <div>
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
        <div
          inert
          lang={locale}
          style={{ transform: "scale(0.8)", transformOrigin: "top left", width: "125%" }}
        >
          <UnsubscribePageView
            m={UNSUBSCRIBE_LOCALES[locale].messages}
            state={state}
            topics={topics}
            minHeight={525}
            customization={customization}
          />
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
        <Select
          value={locale}
          onChange={(value) => setLocale(value as UnsubscribeLocale)}
          ariaLabel={t("previewLanguage")}
          width={190}
          options={Object.entries(UNSUBSCRIBE_LOCALES).map(([value, { name }]) => ({
            value,
            label: name,
          }))}
        />
      </div>
    </div>
  );
}
