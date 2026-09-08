/** Comma-separated multi-value param → the allowed values it names, in `allowed` order. */
export function manyOf<T extends string>(allowed: readonly T[], value: string): T[] {
  const picked = new Set(value.split(","));
  return allowed.filter((v) => picked.has(v));
}
