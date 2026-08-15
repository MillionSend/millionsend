import { getDb } from "@millionsend/db";
import type { Metadata } from "next";
import { headers } from "next/headers";
import en from "../../../../../messages/en/unsubscribe.json";
import ptBR from "../../../../../messages/pt-BR/unsubscribe.json";
import { targetForToken } from "../../lookup";

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
  searchParams: Promise<{ done?: string }>;
}) {
  const [{ token }, query, headerList] = await Promise.all([params, searchParams, headers()]);
  const m = pickMessages(headerList.get("accept-language"));
  const target = await targetForToken(getDb(), token);
  // Already-unsubscribed reads as done: the action is idempotent and the page
  // never asks for something that would change nothing.
  const done = target !== null && (query.done === "1" || target.alreadyDone);
  const topicName = target?.topic?.name;

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
      <Wordmark />
      <div
        className="ms-card"
        style={{ padding: "28px 32px", width: "100%", maxWidth: 420, textAlign: "center" }}
      >
        {target === null ? (
          <p style={{ margin: 0, fontSize: 15, color: "var(--ms-bone)" }}>{m.invalid}</p>
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
            {/* Plain form POST to the canonical route — the page ships no JS. */}
            <form method="post" action={`/unsubscribe/${encodeURIComponent(token)}`}>
              <button type="submit" className="ms-btn ms-btn-primary" style={{ marginTop: 20 }}>
                {m.button}
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
