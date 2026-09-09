import { Fragment } from "react";
import type { UnsubscribeMessages } from "@/lib/unsubscribe-locales";
import {
  UNSUBSCRIBE_LOGO_RADIUS,
  type UnsubscribeLogoRadius,
  unsubscribeAccentStyle,
  unsubscribeThemeStyle,
} from "@/lib/unsubscribe-theme";

export type { UnsubscribeMessages };

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
  logoRadius: UnsubscribeLogoRadius;
  backgroundColor: string | null;
  textColor: string | null;
  accentColor: string | null;
  poweredBy: boolean;
}

export const EMPTY_UNSUBSCRIBE_CUSTOMIZATION: UnsubscribeViewCustomization = {
  brandName: null,
  message: null,
  successMessage: null,
  logoUrl: null,
  logoRadius: "gentle",
  backgroundColor: null,
  textColor: null,
  accentColor: null,
  poweredBy: true,
};

/** A catalog slot ("{topic}", "{brand}") → its element, keeping the catalog's word order. */
function fillSlots(template: string, slots: Record<string, React.ReactNode>) {
  // One split per slot, in the order they appear — the catalog never repeats a
  // slot, so a single pass keeps the surrounding text intact.
  const parts: React.ReactNode[] = [];
  let rest = template;
  let key = 0;
  const re = /\{(topic|brand)\}/;
  let match = re.exec(rest);
  while (match) {
    parts.push(rest.slice(0, match.index));
    parts.push(<Fragment key={key++}>{slots[match[1] as string]}</Fragment>);
    rest = rest.slice(match.index + match[0].length);
    match = re.exec(rest);
  }
  parts.push(rest);
  return <>{parts}</>;
}

/** The sender's topic name inside a heading, allowed to wrap anywhere. */
function TopicName({ name }: { name: string }) {
  return <span style={{ overflowWrap: "anywhere" }}>{name}</span>;
}

const BRAND_MARK_URL = "/logo/millionsend-favicon.svg";

/** "Powered by MillionSend", under the card, linking to the site. */
function PoweredBy({ template }: { template: string }) {
  return (
    <a
      href="https://millionsend.com"
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 13,
        color: "var(--ms-muted)",
        textDecoration: "none",
      }}
    >
      {fillSlots(template, {
        brand: (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              color: "var(--ms-bone)",
              fontWeight: 500,
            }}
          >
            {/* biome-ignore lint/performance/noImgElement: static pre-sized svg, nothing for next/image to optimize */}
            <img src={BRAND_MARK_URL} alt="" width={16} height={16} style={{ borderRadius: 4 }} />
            MillionSend
          </span>
        ),
      })}
    </a>
  );
}

/** Circled check above the success headings; palette and pop match ms-badge-success / ms-copy-mark. */
function SuccessCheck() {
  return (
    <div className="ms-success-check">
      <svg
        width={22}
        height={22}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m4 12.5 5 5L20 6.5" />
      </svg>
    </div>
  );
}

function BrandHeading({ name }: { name: string }) {
  return (
    <span className="ms-display" style={{ fontSize: 22, fontWeight: 600, color: "var(--ms-bone)" }}>
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
  topicName = null,
  topics = [],
  formAction,
  customization,
  minHeight = "100dvh",
}: {
  m: UnsubscribeMessages;
  state: UnsubscribeViewState;
  topicName?: string | null;
  topics?: UnsubscribeViewTopic[];
  formAction?: string;
  customization: UnsubscribeViewCustomization;
  minHeight?: string | number;
}) {
  const theme = unsubscribeThemeStyle(customization);
  const accent = unsubscribeAccentStyle(customization.accentColor);
  const topicSlot = topicName ? { topic: <TopicName name={topicName} /> } : null;
  const confirmText = topicSlot
    ? fillSlots(m.confirmTopic, topicSlot)
    : topics.length > 0
      ? m.confirmPrefs
      : m.confirm;
  const doneText = topicSlot ? fillSlots(m.doneDetailTopic, topicSlot) : m.doneDetail;
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
        boxSizing: "border-box",
        ...theme,
      }}
    >
      {customization.logoUrl ? (
        // biome-ignore lint/performance/noImgElement: recipient-uploaded logo on a no-JS public page
        <img
          src={customization.logoUrl}
          alt={customization.brandName ?? ""}
          style={{
            maxHeight: 48,
            maxWidth: 200,
            objectFit: "contain",
            borderRadius: UNSUBSCRIBE_LOGO_RADIUS[customization.logoRadius],
          }}
        />
      ) : null}
      {customization.brandName ? (
        <BrandHeading name={customization.brandName} />
      ) : customization.logoUrl ? null : (
        <Wordmark />
      )}
      <div
        className="ms-card"
        style={{
          padding: "28px 32px",
          width: "100%",
          maxWidth: 420,
          boxSizing: "border-box",
          textAlign: "center",
        }}
      >
        {customization.message ? (
          <p style={{ margin: "0 0 16px", fontSize: 15, color: "var(--ms-muted)" }}>
            {customization.message}
          </p>
        ) : null}
        {state === "invalid" ? (
          <p style={{ margin: 0, fontSize: 17, color: "var(--ms-bone)" }}>{m.invalid}</p>
        ) : state === "saved" ? (
          <>
            <SuccessCheck />
            <p style={{ margin: 0, fontSize: 20, fontWeight: 600, color: "var(--ms-bone)" }}>
              {successHeading ?? m.saved}
            </p>
          </>
        ) : state === "done" ? (
          <>
            <SuccessCheck />
            <p style={{ margin: 0, fontSize: 20, fontWeight: 600, color: "var(--ms-bone)" }}>
              {successHeading ?? m.done}
            </p>
            <p style={{ margin: "10px 0 0", fontSize: 15, color: "var(--ms-muted)" }}>{doneText}</p>
          </>
        ) : (
          <>
            <p style={{ margin: 0, fontSize: 20, fontWeight: 600, color: "var(--ms-bone)" }}>
              {confirmText}
            </p>
            {topics.length > 0 ? (
              <>
                {/* Two forms, one button row: saving preferences must not
                    trigger the unsubscribe, so each button submits its own
                    form via the `form` attribute (plain HTML — the page
                    ships no JS). The hidden `prefs` marker routes the POST. */}
                <form
                  method="post"
                  action={formAction}
                  id="ms-unsub-prefs"
                  style={{ marginTop: 22, textAlign: "left" }}
                >
                  <input type="hidden" name="prefs" value="1" />
                  <p style={{ margin: "0 0 10px", fontSize: 15, color: "var(--ms-muted)" }}>
                    {m.preferences}
                  </p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {/* A real checkbox posts with the form (the page ships no
                        JS); the switch beside it is what the eye sees. */}
                    {topics.map((topic) => (
                      <label
                        key={topic.id}
                        style={{
                          position: "relative",
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          fontSize: 15.5,
                          color: "var(--ms-bone)",
                          cursor: "pointer",
                        }}
                      >
                        <input
                          type="checkbox"
                          className="ms-switch-input"
                          name="topic"
                          value={topic.id}
                          defaultChecked={topic.subscribed}
                        />
                        <span className="ms-switch" aria-hidden="true">
                          <span />
                        </span>
                        {topic.name}
                      </label>
                    ))}
                  </div>
                </form>
                <form method="post" action={formAction} id="ms-unsub-all" />
                <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 20 }}>
                  <button type="submit" form="ms-unsub-all" className="ms-btn ms-btn-secondary">
                    {m.button}
                  </button>
                  <button
                    type="submit"
                    form="ms-unsub-prefs"
                    className="ms-btn ms-btn-primary"
                    style={accent}
                  >
                    {m.save}
                  </button>
                </div>
              </>
            ) : (
              // Plain form POST to the canonical route.
              <form method="post" action={formAction}>
                <button
                  type="submit"
                  className="ms-btn ms-btn-primary"
                  style={{ marginTop: 20, ...accent }}
                >
                  {m.button}
                </button>
              </form>
            )}
          </>
        )}
      </div>
      {customization.poweredBy ? <PoweredBy template={m.poweredBy} /> : null}
    </div>
  );
}
