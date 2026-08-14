/**
 * Renders a value as a JS single-quoted string literal, escaping
 * backslashes first, then quotes — order matters.
 */
export function jsSingleQuote(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/**
 * Renders a value as one POSIX-shell single-quoted word. Embedded single
 * quotes use the close-escape-reopen pattern ('\''), the only escape that
 * exists inside single quotes.
 */
export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
