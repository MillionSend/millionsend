"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Modal } from "@/components/modal";
import { ModalFooter } from "@/components/modal-footer";

export interface ConfirmDialogOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive confirms render the primary action in the danger style. */
  danger?: boolean;
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
    request?.resolve(ok);
    setRequest(null);
  }

  return (
    <Modal
      open={request !== null}
      onClose={() => close(false)}
      title={request?.title ?? common("confirmTitle")}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          close(true);
        }}
      >
        <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
          {request?.message}
        </p>
        <ModalFooter>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={() => close(false)}>
            {request?.cancelLabel ?? common("cancel")} <span className="ms-keycap">Esc</span>
          </button>
          <button
            type="submit"
            className={request?.danger ? "ms-btn ms-btn-destructive" : "ms-btn ms-btn-primary"}
          >
            {request?.confirmLabel ?? common("confirm")} <span className="ms-keycap">↵</span>
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
