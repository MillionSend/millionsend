"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import {
  UnsubscribePageView,
  type UnsubscribeViewCustomization,
  type UnsubscribeViewState,
  type UnsubscribeViewTopic,
} from "@/app/unsubscribe/page-view";
import { PreviewSchemePills } from "@/components/preview-scheme-pills";
import { Select } from "@/components/select";
import {
  pickUnsubscribeLocale,
  UNSUBSCRIBE_LOCALES,
  type UnsubscribeLocale,
} from "@/lib/unsubscribe-locales";
import { usePreviewScheme } from "@/lib/use-preview-scheme";

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
 * in the dashboard's language and theme and switches to any language the
 * page speaks and either scheme (the public page itself picks the language
 * from Accept-Language and the scheme from the device).
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
  const [scheme, setScheme] = usePreviewScheme();
  return (
    <div>
      <div
        style={{
          border: "1px solid var(--ms-line)",
          borderRadius: "var(--ms-r-card)",
          overflow: "hidden",
        }}
      >
        {/* inert: the preview renders the page's real forms; nothing may submit. */}
        {/* zoom, not transform: it shrinks the layout box too, so the frame follows
            the page's height and its bottom padding shows like the top one.
            zoom × minHeight = 420px, the frame's floor, where the page centers. */}
        {/* data-theme rescopes the color tokens to the scheme being previewed. */}
        <div
          inert
          lang={locale}
          data-theme={scheme}
          style={{
            zoom: 0.8,
            background: "var(--ms-void)",
            colorScheme: scheme,
          }}
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
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
          marginTop: 8,
        }}
      >
        <PreviewSchemePills scheme={scheme} onChange={setScheme} />
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
