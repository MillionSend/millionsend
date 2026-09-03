"use client";

import { useCallback, useEffect, useRef } from "react";

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      execution: "execute";
      appearance: "interaction-only";
      callback: (token: string) => void;
      "error-callback": () => void;
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
function loadTurnstile(): Promise<TurnstileApi> {
  scriptLoading ??= new Promise((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile"));
    script.onerror = () => reject(new Error("turnstile"));
    document.head.appendChild(script);
  });
  return scriptLoading;
}

/**
 * Cloudflare Turnstile behind a form: renders a widget that only shows up
 * when Cloudflare needs an interaction, and hands back a fresh token per
 * submit. With no site key (the instance opted out) `getToken` resolves
 * null and the slot stays empty, so callers never branch on configuration.
 */
export function useTurnstile(siteKey: string | null) {
  const slotRef = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const pending = useRef<{ resolve: (token: string) => void; reject: () => void } | null>(null);

  useEffect(() => {
    const slot = slotRef.current;
    if (!siteKey || !slot) return;
    let cancelled = false;
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled) return;
        widgetId.current = turnstile.render(slot, {
          sitekey: siteKey,
          execution: "execute",
          appearance: "interaction-only",
          callback: (token) => pending.current?.resolve(token),
          "error-callback": () => pending.current?.reject(),
          "expired-callback": () => pending.current?.reject(),
        });
      })
      .catch(() => pending.current?.reject());
    return () => {
      cancelled = true;
      if (widgetId.current) window.turnstile?.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey]);

  const getToken = useCallback((): Promise<string | null> => {
    if (!siteKey) return Promise.resolve(null);
    const id = widgetId.current;
    const turnstile = window.turnstile;
    if (!id || !turnstile) return Promise.reject(new Error("turnstile"));
    return new Promise((resolve, reject) => {
      pending.current = { resolve, reject: () => reject(new Error("turnstile")) };
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
