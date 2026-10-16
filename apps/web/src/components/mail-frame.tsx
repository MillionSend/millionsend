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
  type LinkDestination,
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

interface LinkTip extends LinkDestination {
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
  foldQuote = true,
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
  /** A reply's quoted history folds under "•••"; a forward's never does. */
  foldQuote?: boolean;
}) {
  const t = useTranslations("inboxes");
  const [themeScheme] = usePreviewScheme();
  const shownScheme = scheme ?? themeScheme;
  const prepared = useMemo(() => prepareReceivedHtml(html), [html]);
  const trimmed = foldQuote ? prepared.trimmed : null;
  const [quoteShown, setQuoteShown] = useState(false);
  const body = quoteShown || !trimmed ? prepared.full : trimmed;
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
      imageHosts: images ? body.imageHosts : [],
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
    let raf = 0;
    let watching = 0;
    /** The link the tip names, and where it was drawn. */
    let link: Element | null = null;
    let drawn: Box | null = null;
    /** A link whose tip Esc put away: it stays away until the reader moves on. */
    let dismissed: Element | null = null;
    /** Whether focus was in the message when last looked. */
    let inside = false;
    const measure = () => {
      const root = doc?.documentElement;
      const view = frame.contentWindow;
      if (!root || !view || frame.contentDocument !== doc) return;
      // A sideways scrollbar takes its height out of the viewport.
      setHeight(
        Math.ceil(root.getBoundingClientRect().height) + view.innerHeight - root.clientHeight,
      );
    };
    // The document's own size: images arriving, an expanded <details>, the
    // frame's width. Observed from here, it is heard in every engine.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    /** The tip names the link under the pointer, else the one focused in the message. */
    const update = () => {
      if (!doc) return;
      const focused = document.activeElement === frame;
      const target =
        (frame.matches(":hover") ? doc.querySelector("a[href]:hover, area[href]:hover") : null) ??
        (focused ? (doc.activeElement?.closest("a[href], area[href]") ?? null) : null);
      if (target !== dismissed) dismissed = null;
      const shown = target === dismissed ? null : target;
      // An SVG link's href is no string: it gets no tip.
      const href: unknown = (shown as HTMLAnchorElement | null)?.href;
      if (!shown || typeof href !== "string") {
        if (link) setTip(null);
        link = null;
        drawn = null;
        return;
      }
      const inner = shown.getBoundingClientRect();
      const outer = frame.getBoundingClientRect();
      const left = outer.left + frame.clientLeft;
      const top = outer.top + frame.clientTop;
      const anchor = {
        left: left + inner.left,
        right: left + inner.right,
        top: top + inner.top,
        bottom: top + inner.bottom,
      };
      if (shown === link && drawn?.left === anchor.left && drawn.top === anchor.top) return;
      link = shown;
      drawn = anchor;
      setTip({ ...linkDestination(href), anchor });
    };
    // WebKit runs no listener on a document whose frame allows no scripts,
    // the dashboard's included: while the pointer is over the frame, or one
    // of its links has focus, it is read every frame instead.
    const watch = () => {
      const focused = document.activeElement === frame;
      // A click into the message is one outside the dashboard's open menus and pinned tooltips.
      if (focused && !inside)
        frame.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      inside = focused;
      update();
      const onLink = focused && doc?.activeElement?.closest("a[href], area[href]");
      watching = frame.matches(":hover") || onLink ? requestAnimationFrame(watch) : 0;
    };
    const enter = () => {
      if (watching) return;
      inside = document.activeElement === frame;
      watch();
    };
    // The dashboard's window blurs as focus moves into the frame (Tab onto a
    // link), a moment before the link inside has it.
    const blur = () => {
      if (document.activeElement !== frame || watching) return;
      inside = true;
      watching = requestAnimationFrame(watch);
    };
    // Esc puts the tip away, and only that: the pane's own Esc sees it handled.
    const dismiss = (event: Event) => {
      if ((event as KeyboardEvent).key !== "Escape" || !link) return;
      event.preventDefault();
      dismissed = link;
      link = null;
      drawn = null;
      setTip(null);
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
      ["focusin", update],
      ["scroll", update],
      ["keydown", forward],
    ];
    const attach = () => {
      const current = frame.contentDocument;
      // Cross-origin, past reading: every link opens a new tab, so it never should be.
      if (!current) return;
      if (current === before || current.readyState === "loading") {
        raf = requestAnimationFrame(attach);
        return;
      }
      doc = current;
      for (const [type, listener] of listeners) doc.addEventListener(type, listener, true);
      observer?.observe(doc.documentElement);
      measure();
      if (frame.matches(":hover") || document.activeElement === frame) enter();
    };
    attach();
    frame.addEventListener("load", measure);
    frame.addEventListener("mouseenter", enter);
    window.addEventListener("blur", blur);
    window.addEventListener("scroll", update, { capture: true, passive: true });
    document.addEventListener("focusin", update, true);
    document.addEventListener("keydown", dismiss, true);
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(watching);
      observer?.disconnect();
      frame.removeEventListener("load", measure);
      frame.removeEventListener("mouseenter", enter);
      window.removeEventListener("blur", blur);
      window.removeEventListener("scroll", update, { capture: true });
      document.removeEventListener("focusin", update, true);
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

  // The bar goes with the click: focus moves on to the message it opened up.
  const showImages = () => {
    setImagesShown(true);
    frameRef.current?.focus();
  };

  return (
    <div className={panel ? "ms-mail-panel" : undefined}>
      {body.imageHosts.length > 0 && !images ? (
        <div className="ms-mail-bar">
          <ImageOffIcon />
          <span className="ms-mail-bar-text">{t("mail.imagesHidden")}</span>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={showImages}>
            {t("mail.showImages")}
          </button>
          {trusted ? (
            <button
              type="button"
              className="ms-link"
              onClick={() => {
                alwaysShowImages(domain);
                showImages();
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
      {trimmed ? (
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
              {tip.lead || tip.domain ? (
                <span className="ms-mono ms-mail-host">
                  {tip.lead}
                  {tip.domain ? <strong>{tip.domain}</strong> : null}
                </span>
              ) : null}
              {tip.rest ? <span className="ms-mono ms-mail-href">{tip.rest}</span> : null}
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
