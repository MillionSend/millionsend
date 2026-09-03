"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";

export interface ConfirmDialogOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive confirms render the primary action in the danger style. */
  danger?: boolean;
  /** Irreversible confirms: the action unlocks only after typing the confirm word (DELETE). */
  typeToConfirm?: boolean;
}

interface ConfirmRequest extends ConfirmDialogOptions {
  resolve: (ok: boolean) => void;
}

/* Imperative bridge: callable from anywhere (event handlers, module-level
   guards) without threading React context. The host below registers itself;
   without a mounted host (should never happen under the dashboard layout) the
   native confirm is the safe fallback rather than silently allowing. */
let listener: ((request: ConfirmRequest) => void) | null = null;

/** Our design-system replacement for window.confirm — resolves true on confirm. */
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!listener) {
      resolve(window.confirm(options.message));
      return;
    }
    listener({ ...options, resolve });
  });
}

/** Mounted once (dashboard layout); renders whichever confirm is pending. */
export function ConfirmDialogHost() {
  const common = useTranslations("common");
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const [typed, setTyped] = useState("");
  const word = common("confirmWord");
  const locked = Boolean(request?.typeToConfirm) && typed.trim() !== word;

  useEffect(() => {
    listener = (next) => {
      // A second request while one is open cancels the first — never stack.
      setRequest((prev) => {
        prev?.resolve(false);
        return next;
      });
    };
    return () => {
      listener = null;
    };
  }, []);

  function close(ok: boolean) {
    if (ok && locked) return;
    request?.resolve(ok);
    setRequest(null);
    setTyped("");
  }

  return (
    <Modal
      open={request !== null}
      onClose={() => close(false)}
      onConfirm={() => close(true)}
      title={request?.title ?? common("confirmTitle")}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          close(true);
        }}
      >
        {/* Blank-line-separated paragraphs render as separate blocks so a
            two-part message reads with breathing room instead of one wall. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {(request?.message ?? "").split("\n\n").map((para) => (
            <p
              key={para}
              style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}
            >
              {para}
            </p>
          ))}
        </div>
        {request?.typeToConfirm ? (
          <div className="ms-field" style={{ marginTop: 14 }}>
            <label htmlFor="confirm-word">{common("typeToConfirm", { word })}</label>
            <input
              id="confirm-word"
              className="ms-input mono"
              style={{ width: "100%" }}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              // biome-ignore lint/a11y/noAutofocus: the word is the dialog's only input, and the pointer is already on it
              autoFocus
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
        ) : null}
        <ModalFooter>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={() => close(false)}>
            {request?.cancelLabel ?? common("cancel")} <span className="ms-keycap">Esc</span>
          </button>
          <button
            type="submit"
            className={request?.danger ? "ms-btn ms-btn-destructive" : "ms-btn ms-btn-primary"}
            disabled={locked}
          >
            {request?.confirmLabel ?? common("confirm")} <ConfirmKeycap />
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
