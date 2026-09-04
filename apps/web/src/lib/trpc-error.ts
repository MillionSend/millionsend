/** The tRPC error code a failed query or mutation carries, if any. */
export function trpcErrorCode(error: unknown): string | undefined {
  return (error as { data?: { code?: string } } | null)?.data?.code;
}
