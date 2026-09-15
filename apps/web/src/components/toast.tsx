"use client";

import { useEffect, useState } from "react";

type Tone = "success" | "info" | "warn" | "danger" | "neutral";

interface ToastRequest {
  id: number;
  message: string;
  tone: Tone;
}

/* Imperative bridge like confirm-dialog.tsx: callable from event handlers
   without threading context. The host renders whichever toast is showing. */
let listener: ((request: ToastRequest) => void) | null = null;
let nextId = 1;

/** A transient bottom-center notice; falls back to nothing when no host is mounted. */
export function toast(message: string, tone: Tone = "success"): void {
  listener?.({ id: nextId++, message, tone });
}

const TOAST_MS = 3_200;
const ICON: Record<Tone, string> = {
  success: "✓",
  info: "i",
  warn: "!",
  danger: "✕",
  neutral: "·",
};

export function ToastHost() {
  const [current, setCurrent] = useState<ToastRequest | null>(null);
  useEffect(() => {
    listener = setCurrent;
    return () => {
      listener = null;
    };
  }, []);
  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => setCurrent(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [current]);
  if (!current) return null;
  return (
    <div
      style={{
        position: "fixed",
        left: "50%",
        bottom: 24,
        transform: "translateX(-50%)",
        zIndex: "var(--ms-z-menu)",
        maxWidth: "calc(100vw - 32px)",
      }}
    >
      <div role="status" className={`ms-toast ms-toast-${current.tone}`}>
        <span className="ms-toast-icon" aria-hidden="true">
          {ICON[current.tone]}
        </span>
        <span>{current.message}</span>
      </div>
    </div>
  );
}
