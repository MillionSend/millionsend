"use client";

import { useEffect, useState } from "react";
import { emailSha256, gravatarUrl, initials } from "@/lib/avatar";

/**
 * Contact identity mark: a letter circle (initials from the name, else the
 * email) that a Gravatar photo covers when one exists. Circular on purpose —
 * teams keep the rounded-square TeamLogo tile, so the two never read alike.
 */
export function ContactAvatar({
  email,
  name,
  size,
}: {
  email: string;
  name?: string | null | undefined;
  size: number;
}) {
  const [hash, setHash] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setHash(null);
    setFailed(false);
    void emailSha256(email).then((h) => {
      if (alive) setHash(h);
    });
    return () => {
      alive = false;
    };
  }, [email]);

  return (
    <span
      aria-hidden="true"
      style={{
        position: "relative",
        width: size,
        height: size,
        borderRadius: "50%",
        border: "1px solid var(--ms-line)",
        background: "var(--ms-panel-raised)",
        color: "var(--ms-muted)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.38),
        fontWeight: 600,
        flex: "none",
        overflow: "hidden",
        boxSizing: "border-box",
      }}
    >
      {initials(name?.trim() ? name : email)}
      {hash && !failed ? (
        // biome-ignore lint/performance/noImgElement: third-party host with a 404 fallback contract; next/image would error-log misses instead of falling back
        <img
          src={gravatarUrl(hash, size * 2)}
          alt=""
          onError={() => setFailed(true)}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      ) : null}
    </span>
  );
}
