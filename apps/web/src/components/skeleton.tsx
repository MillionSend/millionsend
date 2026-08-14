/**
 * Loading placeholders (.ms-skeleton). Rule: no spinners or blank panels
 * before tables/cards — each surface renders a skeleton mirroring its real
 * layout, composed from these blocks.
 */
export function Skeleton({
  width,
  height = 12,
  radius = "var(--ms-r-chip)",
}: {
  width: number | string;
  height?: number | string;
  radius?: number | string;
}) {
  return (
    <span
      aria-hidden="true"
      className="ms-skeleton"
      style={{ width, height, borderRadius: radius }}
    />
  );
}

/** Pill-shaped stand-in matching .ms-chip metrics (CopyChip cells). */
export function SkeletonChip({ width }: { width: number | string }) {
  return <Skeleton width={width} height={24} radius="var(--ms-r-input)" />;
}

/** Badge-shaped stand-in matching .ms-badge metrics (status cells). */
export function SkeletonBadge({ width = 64 }: { width?: number | string }) {
  return <Skeleton width={width} height={22} radius="var(--ms-r-chip)" />;
}
