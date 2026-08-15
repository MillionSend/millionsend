/** HTTP status → status-token color: 2xx success, 4xx warn, 5xx danger, other muted. */
export function statusCodeColor(statusCode: number): string {
  if (statusCode >= 500) return "var(--ms-danger)";
  if (statusCode >= 400) return "var(--ms-warn)";
  if (statusCode >= 200 && statusCode < 300) return "var(--ms-success)";
  return "var(--ms-muted)";
}
