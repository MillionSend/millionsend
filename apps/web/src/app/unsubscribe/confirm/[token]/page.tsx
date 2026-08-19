import { getDb } from "@millionsend/db";
import type { Metadata } from "next";
import { headers } from "next/headers";
import en from "../../../../../messages/en/unsubscribe.json";
import ptBR from "../../../../../messages/pt-BR/unsubscribe.json";
import { preferenceTopics, targetForToken } from "../../lookup";

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

/** "{email}"/"{topic}" slots → mono span, keeping the catalog's sentence order. */
function fillSlots(template: string, slots: Record<string, string>) {
  // One split per slot, in the order they appear — the catalog never repeats a
  // slot, so a single pass keeps the surrounding text intact.
  const parts: React.ReactNode[] = [];
  let rest = template;
  let key = 0;
  const re = /\{(email|topic)\}/;
  let match = re.exec(rest);
  while (match) {
    parts.push(rest.slice(0, match.index));
    parts.push(
      <span key={key++} className="ms-mono" style={{ overflowWrap: "anywhere" }}>
        {slots[match[1] as "email" | "topic"]}
      </span>,
    );
    rest = rest.slice(match.index + match[0].length);
    match = re.exec(rest);
  }
  parts.push(rest);
  return <>{parts}</>;
}

function BrandHeading({ name }: { name: string }) {
  return (
    <span className="ms-display" style={{ fontSize: 20, fontWeight: 600, color: "var(--ms-bone)" }}>
      {name}
    </span>
  );
}

function Wordmark() {
  return (
    <>
      {/* biome-ignore lint/performance/noImgElement: static pre-sized svg, nothing for next/image to optimize */}
      <img
        className="ms-dark-only"
        src="/logo/millionsend-wordmark.svg"
        alt="MillionSend"
        height={20}
      />
      {/* biome-ignore lint/performance/noImgElement: static pre-sized svg, nothing for next/image to optimize */}
      <img
        className="ms-light-only"
        src="/logo/millionsend-wordmark-light.svg"
        alt="MillionSend"
        height={20}
      />
    </>
  );
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
  const topicName = target?.topic?.name;
  const brandName = target?.customization.brandName ?? null;
  const customMessage = target?.customization.message ?? null;

  const confirmText =
    target && topicName
      ? fillSlots(m.confirmTopic, { email: target.email, topic: topicName })
      : target
        ? fillSlots(m.confirm, { email: target.email })
        : null;
  const doneText =
    target && topicName
      ? fillSlots(m.doneDetailTopic, { email: target.email, topic: topicName })
      : target
        ? fillSlots(m.doneDetail, { email: target.email })
        : null;

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 28,
        padding: 24,
      }}
    >
      {brandName ? <BrandHeading name={brandName} /> : <Wordmark />}
      <div
        className="ms-card"
        style={{ padding: "28px 32px", width: "100%", maxWidth: 420, textAlign: "center" }}
      >
        {customMessage ? (
          <p style={{ margin: "0 0 16px", fontSize: 13.5, color: "var(--ms-muted)" }}>
            {customMessage}
          </p>
        ) : null}
        {target === null ? (
          <p style={{ margin: 0, fontSize: 15, color: "var(--ms-bone)" }}>{m.invalid}</p>
        ) : saved ? (
          <p style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--ms-bone)" }}>
            {m.saved}
          </p>
        ) : done ? (
          <>
            <p style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--ms-bone)" }}>
              {m.done}
            </p>
            <p style={{ margin: "10px 0 0", fontSize: 13.5, color: "var(--ms-muted)" }}>
              {doneText}
            </p>
          </>
        ) : (
          <>
            <p style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--ms-bone)" }}>
              {confirmText}
            </p>
            {topics.length > 0 ? (
              // Separate form: saving preferences must not trigger the
              // unsubscribe below. The hidden `prefs` marker routes the POST.
              <form
                method="post"
                action={`/unsubscribe/${encodeURIComponent(token)}`}
                style={{ marginTop: 20, textAlign: "left" }}
              >
                <input type="hidden" name="prefs" value="1" />
                <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--ms-muted)" }}>
                  {m.preferences}
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {topics.map((topic) => (
                    <label
                      key={topic.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        fontSize: 14,
                        color: "var(--ms-bone)",
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        name="topic"
                        value={topic.id}
                        defaultChecked={topic.subscribed}
                      />
                      {topic.name}
                    </label>
                  ))}
                </div>
                <button
                  type="submit"
                  className="ms-btn ms-btn-secondary"
                  style={{ marginTop: 14, width: "100%" }}
                >
                  {m.save}
                </button>
              </form>
            ) : null}
            {/* Plain form POST to the canonical route — the page ships no JS. */}
            <form method="post" action={`/unsubscribe/${encodeURIComponent(token)}`}>
              <button
                type="submit"
                className="ms-btn ms-btn-primary"
                style={{ marginTop: topics.length > 0 ? 12 : 20 }}
              >
                {m.button}
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
