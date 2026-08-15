import { getDb } from "@millionsend/db";
import type { Metadata } from "next";
import { headers } from "next/headers";
import en from "../../../../../messages/en/unsubscribe.json";
import ptBR from "../../../../../messages/pt-BR/unsubscribe.json";
import { contactForToken } from "../../lookup";

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

/** "{email}" slot → mono span, keeping the sentence order the catalog chose. */
function fillEmail(template: string, email: string) {
  const [before, after] = template.split("{email}");
  return (
    <>
      {before}
      <span className="ms-mono" style={{ overflowWrap: "anywhere" }}>
        {email}
      </span>
      {after}
    </>
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
  searchParams: Promise<{ done?: string }>;
}) {
  const [{ token }, query, headerList] = await Promise.all([params, searchParams, headers()]);
  const m = pickMessages(headerList.get("accept-language"));
  const contact = await contactForToken(getDb(), token);
  // Already-unsubscribed reads as done: the action is idempotent and the
  // page never asks for something that would change nothing.
  const done = contact !== null && (query.done === "1" || contact.unsubscribed);

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
        {contact === null ? (
          <p style={{ margin: 0, fontSize: 15, color: "var(--ms-bone)" }}>{m.invalid}</p>
        ) : done ? (
          <>
            <p style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--ms-bone)" }}>
              {m.done}
            </p>
            <p style={{ margin: "10px 0 0", fontSize: 13.5, color: "var(--ms-muted)" }}>
              {fillEmail(m.doneDetail, contact.email)}
            </p>
          </>
        ) : (
          <>
            <p style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--ms-bone)" }}>
              {fillEmail(m.confirm, contact.email)}
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
