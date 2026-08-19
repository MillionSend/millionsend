/**
 * Team avatar: the uploaded logo when present, else the initial-letter tile.
 * Same rounded-square metrics either way, so switcher rows, the trigger, and
 * settings all share one identity mark.
 */
export function TeamLogo({
  name,
  logoUrl,
  size,
}: {
  name: string;
  logoUrl?: string | null | undefined;
  size: number;
}) {
  const frame: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: Math.round(size * 0.3),
    border: "1px solid var(--ms-line)",
    flex: "none",
    boxSizing: "border-box",
  };
  if (logoUrl) {
    return (
      // biome-ignore lint/performance/noImgElement: bucket/CDN host is deployment-configured, so it cannot be in next/image remotePatterns
      <img
        src={logoUrl}
        alt=""
        aria-hidden="true"
        style={{ ...frame, objectFit: "cover", display: "block" }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{
        ...frame,
        background: "var(--ms-panel-raised)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.46),
        fontWeight: 600,
      }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}
