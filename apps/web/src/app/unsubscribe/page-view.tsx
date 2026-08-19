import { unsubscribeAccentStyle, unsubscribeThemeStyle } from "@/lib/unsubscribe-theme";
import type en from "../../../messages/en/unsubscribe.json";

/** Recipient-facing catalog shape (en and pt-BR are structurally identical). */
export type UnsubscribeMessages = typeof en;

export type UnsubscribeViewState = "invalid" | "confirm" | "saved" | "done";

export interface UnsubscribeViewTopic {
  id: string;
  name: string;
  subscribed: boolean;
}

/** What the page renders from team settings; every field falls back to defaults. */
export interface UnsubscribeViewCustomization {
  brandName: string | null;
  message: string | null;
  successMessage: string | null;
  logoUrl: string | null;
  backgroundColor: string | null;
  textColor: string | null;
  accentColor: string | null;
}

export const EMPTY_UNSUBSCRIBE_CUSTOMIZATION: UnsubscribeViewCustomization = {
  brandName: null,
  message: null,
  successMessage: null,
  logoUrl: null,
  backgroundColor: null,
  textColor: null,
  accentColor: null,
};

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

/**
 * The hosted unsubscribe page, presentational only — rendered by the public
 * confirm route and, scaled down, by the settings editor's live preview. It
 * ships no JS: forms POST to `formAction` (omit it for inert previews).
 * Custom colors flow exclusively through unsubscribeThemeStyle, which drops
 * anything that is not a strict 6-digit hex.
 */
export function UnsubscribePageView({
  m,
  state,
  email = "",
  topicName = null,
  topics = [],
  formAction,
  customization,
  minHeight = "100dvh",
}: {
  m: UnsubscribeMessages;
  state: UnsubscribeViewState;
  email?: string;
  topicName?: string | null;
  topics?: UnsubscribeViewTopic[];
  formAction?: string;
  customization: UnsubscribeViewCustomization;
  minHeight?: string | number;
}) {
  const theme = unsubscribeThemeStyle(customization);
  const accent = unsubscribeAccentStyle(customization.accentColor);
  const confirmText = topicName
    ? fillSlots(m.confirmTopic, { email, topic: topicName })
    : fillSlots(m.confirm, { email });
  const doneText = topicName
    ? fillSlots(m.doneDetailTopic, { email, topic: topicName })
    : fillSlots(m.doneDetail, { email });
  const successHeading = customization.successMessage;

  return (
    <div
      style={{
        minHeight,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 28,
        padding: 24,
        ...theme,
      }}
    >
      {customization.logoUrl ? (
        // biome-ignore lint/performance/noImgElement: recipient-uploaded logo on a no-JS public page
        <img
          src={customization.logoUrl}
          alt={customization.brandName ?? ""}
          style={{ maxHeight: 48, maxWidth: 200, objectFit: "contain" }}
        />
      ) : null}
      {customization.brandName ? (
        <BrandHeading name={customization.brandName} />
      ) : customization.logoUrl ? null : (
        <Wordmark />
      )}
      <div
        className="ms-card"
        style={{ padding: "28px 32px", width: "100%", maxWidth: 420, textAlign: "center" }}
      >
        {customization.message ? (
          <p style={{ margin: "0 0 16px", fontSize: 13.5, color: "var(--ms-muted)" }}>
            {customization.message}
          </p>
        ) : null}
        {state === "invalid" ? (
          <p style={{ margin: 0, fontSize: 15, color: "var(--ms-bone)" }}>{m.invalid}</p>
        ) : state === "saved" ? (
          <p style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--ms-bone)" }}>
            {successHeading ?? m.saved}
          </p>
        ) : state === "done" ? (
          <>
            <p style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--ms-bone)" }}>
              {successHeading ?? m.done}
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
              <form method="post" action={formAction} style={{ marginTop: 20, textAlign: "left" }}>
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
            <form method="post" action={formAction}>
              <button
                type="submit"
                className="ms-btn ms-btn-primary"
                style={{ marginTop: topics.length > 0 ? 12 : 20, ...accent }}
              >
                {m.button}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
