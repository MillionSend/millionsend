import { Skeleton } from "@/components/skeleton";

/**
 * Instant-navigation fallback for every dashboard section. The whole route
 * tree is dynamic (the layout reads auth cookies), and Next only prefetches
 * a dynamic route when it has a loading boundary — without this file a
 * sidebar click sits frozen for a full server round trip before anything
 * moves. Renders inside the persistent AppShell, so only the content area
 * swaps; kept to the shared page anatomy (title, toolbar, surface) because
 * each page paints its own exact skeleton the moment its shell lands.
 */
export default function DashboardLoading() {
  return (
    <>
      <div style={{ marginBottom: 28, display: "flex" }}>
        <h1 className="ms-display" style={{ fontSize: "var(--ms-fs-h1)", margin: 0, flex: "none" }}>
          <Skeleton width={220} height="1lh" />
        </h1>
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 18 }}>
        <Skeleton width={220} height={30} radius="var(--ms-r-input)" />
        <Skeleton width={120} height={30} radius="var(--ms-r-input)" />
      </div>
      <Skeleton width="100%" height={220} radius="var(--ms-r-card)" />
    </>
  );
}
