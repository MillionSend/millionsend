"use client";

import { useTranslations } from "next-intl";
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ImageOffIcon } from "@/components/icons/mail-icons";
import { Tooltip } from "@/components/tooltip";
import {
  alwaysShowImages,
  type EmailScheme,
  emulateEmailScheme,
  imagesAlwaysShown,
  linkDestination,
  lockDownReceivedHtml,
  onImagesAlwaysShown,
  PREVIEW_CANVAS,
  prepareReceivedHtml,
  withoutTrailingQuote,
} from "@/lib/email-preview";
import { type Box, placePanel, viewportSize } from "@/lib/panel-placement";
import { usePreviewScheme } from "@/lib/use-preview-scheme";

/** The frame's height until its document is measured. */
const MIN_HEIGHT = 120;
const TIP_GAP = 8;
/*
 * The document sizes the frame, never the other way round: a root as tall as
 * the viewport (height:100% is common in mail) could only ever grow. Vertical
 * overflow stays hidden, so no inner scrollbar shows while a measurement
 * settles; a wide message still scrolls sideways inside its own box.
 */
const FIT_TO_CONTENT =
  "<style>html{height:auto!important;min-height:0!important;overflow-y:hidden!important}</style>";
// A mail client's own default, under whatever the message sets: replies from
// Gmail or Apple Mail carry no font, and the browser's would be a serif.
const CLIENT_FONT = "<style>body{font-family:sans-serif;font-size:13.5px}</style>";

interface LinkTip {
  text: string;
  mail: boolean;
  /** The link's box in the dashboard's viewport. */
  anchor: Box;
}

/** The "•••" under a message whose quoted history is folded. */
function QuoteToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  const t = useTranslations("inboxes");
  const label = t(shown ? "mail.hideQuoted" : "mail.showQuoted");
  return (
    // A line of its own: the tooltip's trigger is inline.
    <div>
      <Tooltip inline focusableChild text={label}>
        <button
          type="button"
          className="ms-mail-quote"
          aria-label={label}
          aria-expanded={shown}
          onClick={onToggle}
        >
          •••
        </button>
      </Tooltip>
    </div>
  );
}

/** A plain-text body, its trailing quoted history folded under the same toggle. */
export function MailText({ text, foldQuote = true }: { text: string; foldQuote?: boolean }) {
  const folded = useMemo(() => (foldQuote ? withoutTrailingQuote(text) : null), [text, foldQuote]);
  const [quoteShown, setQuoteShown] = useState(false);
  return (
    <>
      <p
        style={{
          margin: "10px 0 0",
          fontSize: 13.5,
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {folded === null || quoteShown ? text : folded}
      </p>
      {folded === null ? null : (
        <QuoteToggle shown={quoteShown} onToggle={() => setQuoteShown((shown) => !shown)} />
      )}
    </>
  );
}

/**
 * A received message's HTML in a sandboxed frame sized to its content. No
 * script ever runs in it: allow-same-origin is there only so the dashboard
 * can measure the document and read its links, and without allow-scripts the
 * message still cannot use it. Remote images wait for the reader, or load on
 * their own for a domain the reader chose once authentication proves it.
 */
export function MailFrame({
  html,
  title,
  domain,
  authenticated,
  scheme,
  panel = false,
}: {
  html: string;
  title: string;
  /** The From address's domain: what "Always for" remembers. */
  domain: string;
  /** Authentication ties the message to `domain`; only then may its images load unasked. */
  authenticated: boolean;
  /** The mail client imitated; the dashboard's theme by default. */
  scheme?: EmailScheme | undefined;
  /** Edge to edge in a panel, rather than boxed inside a card. */
  panel?: boolean;
}) {
  const t = useTranslations("inboxes");
  const [themeScheme] = usePreviewScheme();
  const shownScheme = scheme ?? themeScheme;
  const prepared = useMemo(() => prepareReceivedHtml(html), [html]);
  const [quoteShown, setQuoteShown] = useState(false);
  const body = quoteShown || !prepared.trimmed ? prepared.full : prepared.trimmed;
  // A spoofed From proves no domain, so it never gets images loaded unasked.
  const trusted = authenticated && domain !== "";
  const always = useSyncExternalStore(
    onImagesAlwaysShown,
    () => trusted && imagesAlwaysShown(domain),
    () => false,
  );
  const [imagesShown, setImagesShown] = useState(false);
  const images = imagesShown || always;
  const srcDoc =
    lockDownReceivedHtml(emulateEmailScheme(CLIENT_FONT + body.html, shownScheme), {
      remoteImages: images,
    }) + FIT_TO_CONTENT;

  const frameRef = useRef<HTMLIFrameElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [tip, setTip] = useState<LinkTip | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies(srcDoc): each new document is attached to once it replaces the one before
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    // A new srcdoc loads asynchronously: until then the frame still holds the
    // document before it (the initial blank one, or the last rendering).
    const before = frame.contentDocument;
    let doc: Document | null = null;
    let link: Element | null = null;
    let width = frame.clientWidth;
    let raf = 0;
    const measure = () => {
      const root = doc?.documentElement;
      const view = frame.contentWindow;
      if (!root || !view) return;
      // A sideways scrollbar takes its height out of the viewport.
      setHeight(
        Math.ceil(root.getBoundingClientRect().height) + view.innerHeight - root.clientHeight,
      );
    };
    const follow = (target: EventTarget | null) => {
      const found =
        target && "closest" in target ? (target as Element).closest("a[href], area[href]") : null;
      // An SVG link's href is no string: it gets no tip.
      const href = (found as HTMLAnchorElement | null)?.href;
      const next = typeof href === "string" ? found : null;
      if (next === link) return;
      link = next;
      if (!next || typeof href !== "string") {
        setTip(null);
        return;
      }
      const inner = next.getBoundingClientRect();
      const outer = frame.getBoundingClientRect();
      const left = outer.left + frame.clientLeft;
      const top = outer.top + frame.clientTop;
      setTip({
        ...linkDestination(href),
        anchor: {
          left: left + inner.left,
          right: left + inner.right,
          top: top + inner.top,
          bottom: top + inner.bottom,
        },
      });
    };
    const hide = () => follow(null);
    // Esc dismisses an open tip, and only that: the pane's own Esc sees it handled.
    const dismiss = (event: Event) => {
      if ((event as KeyboardEvent).key !== "Escape" || !link) return;
      event.preventDefault();
      hide();
    };
    // Keys pressed in the message never reach the dashboard's window: an Esc
    // the tip didn't take goes on from the frame, so the page's own Esc
    // (closing the thread) still hears it. Not one typed in a field.
    const forward = (event: Event) => {
      dismiss(event);
      const target = event.target as HTMLElement;
      if ((event as KeyboardEvent).key !== "Escape" || event.defaultPrevented) return;
      if (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      frame.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    };
    const listeners: [string, (event: Event) => void][] = [
      ["load", measure],
      ["error", measure],
      ["mouseover", (event) => follow(event.target)],
      // A scroll hides the tip it would misplace; the pointer's next move brings it back.
      ["mousemove", (event) => follow(event.target)],
      ["focusin", (event) => follow(event.target)],
      [
        "mouseout",
        (event) => {
          // Leaving the frame; a move between its elements is the next mouseover's call.
          if (!(event as MouseEvent).relatedTarget) hide();
        },
      ],
      ["focusout", (event) => follow((event as FocusEvent).relatedTarget)],
      ["keydown", forward],
      ["scroll", hide],
    ];
    const attach = () => {
      const current = frame.contentDocument;
      // Gone cross-origin: a link with its own target navigated the frame.
      if (!current) return;
      if (current === before || current.readyState === "loading") {
        raf = requestAnimationFrame(attach);
        return;
      }
      doc = current;
      for (const [type, listener] of listeners) doc.addEventListener(type, listener, true);
      measure();
    };
    attach();
    frame.addEventListener("load", measure);
    window.addEventListener("scroll", hide, { capture: true, passive: true });
    document.addEventListener("keydown", dismiss, true);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (frame.clientWidth === width) return;
            width = frame.clientWidth;
            measure();
          });
    observer?.observe(frame);
    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      frame.removeEventListener("load", measure);
      window.removeEventListener("scroll", hide, { capture: true });
      document.removeEventListener("keydown", dismiss, true);
      for (const [type, listener] of listeners) doc?.removeEventListener(type, listener, true);
      if (link) setTip(null);
    };
  }, [srcDoc]);

  // Placed after measuring, like the app's other tooltips: under the link,
  // from its start, kept inside the viewport.
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el || !tip) return;
    const placed = placePanel(
      tip.anchor,
      { width: el.offsetWidth, height: el.offsetHeight },
      viewportSize(),
      { align: "start", prefer: "below", gap: TIP_GAP },
    );
    el.style.left = `${placed.left}px`;
    el.style.top = `${placed.top}px`;
  }, [tip]);

  return (
    <div className={panel ? "ms-mail-panel" : undefined}>
      {body.remoteImages && !images ? (
        <div className="ms-mail-bar">
          <ImageOffIcon />
          <span className="ms-mail-bar-text">{t("mail.imagesHidden")}</span>
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            onClick={() => setImagesShown(true)}
          >
            {t("mail.showImages")}
          </button>
          {trusted ? (
            <button
              type="button"
              className="ms-link"
              onClick={() => {
                alwaysShowImages(domain);
                setImagesShown(true);
              }}
            >
              {t("mail.alwaysFor", { domain })}
            </button>
          ) : null}
        </div>
      ) : null}
      <iframe
        ref={frameRef}
        title={title}
        // Never allow-scripts, allow-forms or allow-top-navigation.
        sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
        srcDoc={srcDoc}
        className="ms-mail-frame"
        style={{ height, background: PREVIEW_CANVAS[shownScheme] }}
      />
      {prepared.trimmed ? (
        <QuoteToggle shown={quoteShown} onToggle={() => setQuoteShown((shown) => !shown)} />
      ) : null}
      {tip
        ? createPortal(
            <div
              ref={tipRef}
              role="tooltip"
              className="ms-tooltip"
              // First-paint guess; the layout effect places it before paint.
              style={{ left: tip.anchor.left, top: tip.anchor.bottom + TIP_GAP }}
            >
              <span className="ms-mono ms-mail-href">{tip.text}</span>
              {tip.mail ? null : (
                <span className="ms-mail-href-note">{t("mail.opensInNewTab")}</span>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
