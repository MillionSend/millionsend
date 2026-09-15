import { Skeleton } from "@/components/skeleton";

/** Instant-navigation fallback for the console routes (see the dashboard's loading.tsx). */
export default function ConsoleLoading() {
  return (
    <>
      <div style={{ marginBottom: 28, display: "flex" }}>
        <h1 className="ms-display" style={{ fontSize: "var(--ms-fs-h1)", margin: 0, flex: "none" }}>
          <Skeleton width={220} height="1lh" />
        </h1>
      </div>
      <div className="ms-grid ms-grid-4" style={{ marginBottom: 16 }}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} width="100%" height={150} radius="var(--ms-r-card)" />
        ))}
      </div>
      <Skeleton width="100%" height={280} radius="var(--ms-r-card)" />
    </>
  );
}
