import { escapeRegExp } from "./escape";

export interface MatchRange {
  start: number;
  end: number;
}

/**
 * Case-insensitive, non-overlapping occurrences of `query` in `text`, in
 * order; none for an empty query. Matched through a RegExp rather than
 * lowercased copies: lowercasing can change a string's length (İ → i̇) and
 * shift every offset after it.
 */
export function findMatches(text: string, query: string): MatchRange[] {
  if (query === "") return [];
  const re = new RegExp(escapeRegExp(query), "gi");
  return Array.from(text.matchAll(re), (m) => ({ start: m.index, end: m.index + m[0].length }));
}

/** The match after `index` (before it for -1), wrapping at either end; -1 without matches. */
export function stepMatch(count: number, index: number, dir: 1 | -1): number {
  if (count === 0) return -1;
  if (index < 0) return dir === 1 ? 0 : count - 1;
  return (index + dir + count) % count;
}

/** The first match starting at or after `caret`, else the first of all; -1 without matches. */
export function nearestMatch(matches: MatchRange[], caret: number): number {
  if (matches.length === 0) return -1;
  const i = matches.findIndex((m) => m.start >= caret);
  return i === -1 ? 0 : i;
}
