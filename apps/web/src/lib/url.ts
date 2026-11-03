/** True when the URL's host can only be reached from its own machine. */
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

/** An in-app path as a link to send someone; the bare path where no window exists (a server render). */
export function absoluteUrl(path: string): string {
  return typeof window === "undefined" ? path : new URL(path, window.location.origin).href;
}
