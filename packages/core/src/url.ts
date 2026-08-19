/**
 * True when the URL's host can only be reached from its own machine.
 * Mirrored client-side at apps/web/src/lib/url.ts — restated there because
 * this package's entry point is server-only.
 */
export function isLoopbackUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return (
      host === "localhost" ||
      host === "::1" ||
      host === "[::1]" ||
      host.startsWith("127.") ||
      host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}
