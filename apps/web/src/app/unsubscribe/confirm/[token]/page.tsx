import { getDb } from "@millionsend/db";
import type { Metadata } from "next";
import { headers } from "next/headers";
import en from "../../../../../messages/en/unsubscribe.json";
import ptBR from "../../../../../messages/pt-BR/unsubscribe.json";
import { preferenceTopics, targetForToken } from "../../lookup";
import {
  EMPTY_UNSUBSCRIBE_CUSTOMIZATION,
  UnsubscribePageView,
  type UnsubscribeViewState,
} from "../../page-view";

export const metadata: Metadata = { robots: { index: false, follow: false } };

const MESSAGES = { en, "pt-BR": ptBR } as const;

/**
 * Public page: locale comes from Accept-Language, never from the dashboard's
 * locale cookie — recipients are not dashboard users. First recognized tag
 * wins; anything that isn't Portuguese reads English.
 */
function pickMessages(acceptLanguage: string | null): (typeof MESSAGES)[keyof typeof MESSAGES] {
  for (const part of (acceptLanguage ?? "").toLowerCase().split(",")) {
    const tag = part.trim();
    if (tag.startsWith("pt")) return MESSAGES["pt-BR"];
    if (tag.startsWith("en")) return MESSAGES.en;
  }
  return MESSAGES.en;
}

export default async function UnsubscribeConfirmPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ done?: string; saved?: string }>;
}) {
  const [{ token }, query, headerList] = await Promise.all([params, searchParams, headers()]);
  const m = pickMessages(headerList.get("accept-language"));
  const db = getDb();
  const target = await targetForToken(db, token);
  const saved = target !== null && query.saved === "1";
  // Already-unsubscribed reads as done: the action is idempotent and the page
  // never asks for something that would change nothing.
  const done = !saved && target !== null && (query.done === "1" || target.alreadyDone);
  const topics = target !== null && !saved && !done ? await preferenceTopics(db, target) : [];
  const state: UnsubscribeViewState =
    target === null ? "invalid" : saved ? "saved" : done ? "done" : "confirm";

  return (
    <main>
      <UnsubscribePageView
        m={m}
        state={state}
        topicName={target?.topic?.name ?? null}
        topics={topics}
        formAction={`/unsubscribe/${encodeURIComponent(token)}`}
        customization={target?.customization ?? EMPTY_UNSUBSCRIBE_CUSTOMIZATION}
      />
    </main>
  );
}
