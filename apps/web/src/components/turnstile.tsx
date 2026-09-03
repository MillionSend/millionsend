"use client";

import { useCallback, useEffect, useRef } from "react";

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
/* Global Turnstile calls once the API is usable: the supported "ready" signal
   for a script added at runtime (turnstile.ready() throws for async tags). */
const ONLOAD_CALLBACK = "__millionsendTurnstileLoaded";
/* A token request that never settles must fail visibly, not hang the button. */
const TOKEN_TIMEOUT_MS = 30_000;

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      execution: "execute";
      appearance: "interaction-only";
      callback: (token: string) => void;
      "error-callback": (code?: string) => void;
      "expired-callback": () => void;
    },
  ): string;
  execute(widgetId: string): void;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptLoading: Promise<TurnstileApi> | undefined;
/** Loads the API once and resolves when Turnstile calls back that it is usable. */
function loadTurnstile(): Promise<TurnstileApi> {
  scriptLoading ??= new Promise((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    (window as unknown as Record<string, unknown>)[ONLOAD_CALLBACK] = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("turnstile"));
    };
    const script = document.createElement("script");
    script.src = `${SCRIPT_URL}&onload=${ONLOAD_CALLBACK}`;
    script.async = true;
    script.onerror = () => reject(new Error("turnstile"));
    document.head.appendChild(script);
  });
  return scriptLoading;
}

/**
 * Cloudflare Turnstile behind a form: a widget that only shows up when
 * Cloudflare needs an interaction, handing back a fresh token per submit.
 * The widget is rendered lazily, on the first token request, because the
 * slot may mount well after the hook (a button that appears once data
 * loads); the script itself is fetched as soon as the hook mounts. With no
 * site key (the instance opted out) `getToken` resolves null and the slot
 * stays empty, so callers never branch on configuration.
 */
export function useTurnstile(siteKey: string | null) {
  const slotRef = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const pending = useRef<{ resolve: (token: string) => void; reject: () => void } | null>(null);

  useEffect(() => {
    if (!siteKey) return;
    void loadTurnstile().catch(() => {});
    return () => {
      if (widgetId.current) window.turnstile?.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey]);

  const getToken = useCallback(async (): Promise<string | null> => {
    if (!siteKey) return null;
    const turnstile = await loadTurnstile();
    if (!widgetId.current) {
      const slot = slotRef.current;
      if (!slot) throw new Error("turnstile");
      widgetId.current = turnstile.render(slot, {
        sitekey: siteKey,
        execution: "execute",
        appearance: "interaction-only",
        callback: (token) => pending.current?.resolve(token),
        "error-callback": (code) => {
          // Cloudflare's code (e.g. 110200 = hostname not on the widget) is
          // the one clue an operator gets; keep it visible.
          console.warn("Turnstile error", code);
          pending.current?.reject();
        },
        "expired-callback": () => pending.current?.reject(),
      });
    }
    const id = widgetId.current;
    return new Promise((resolve, reject) => {
      const fail = () => reject(new Error("turnstile"));
      const timer = window.setTimeout(fail, TOKEN_TIMEOUT_MS);
      pending.current = {
        resolve: (token) => {
          window.clearTimeout(timer);
          resolve(token);
        },
        reject: () => {
          window.clearTimeout(timer);
          fail();
        },
      };
      turnstile.reset(id);
      turnstile.execute(id);
    });
  }, [siteKey]);

  return { slot: <div ref={slotRef} />, getToken };
}

/** Better Auth's captcha plugin reads the token from this header. */
export function captchaHeaders(token: string | null): Record<string, string> {
  return token ? { "x-captcha-response": token } : {};
}
