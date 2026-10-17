"use client";

import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { useState } from "react";
import superjson from "superjson";
import { TRPCProvider } from "@/lib/trpc";
import { trpcErrorCode } from "@/lib/trpc-error";
import type { AppRouter } from "@/server/routers";

// Answers that will not change on a retry: a record that is gone, one in a
// state that rules the read out (held mail released meanwhile), or one the
// caller may not see. Everything else keeps react-query's default three tries.
const FINAL_CODES = new Set(["NOT_FOUND", "CONFLICT", "FORBIDDEN", "UNAUTHORIZED", "BAD_REQUEST"]);

export function makeQueryClient() {
  return new QueryClient({
    // A write can change what any screen shows, so every success marks the
    // whole cache stale: each view refetches on its next mount or focus.
    // Nothing refetches now — a view on screen refreshes in its own onSuccess.
    mutationCache: new MutationCache({
      onSuccess: (_data, _variables, _result, _mutation, { client }) =>
        client.invalidateQueries({ refetchType: "none" }),
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failureCount, error) =>
          !FINAL_CODES.has(trpcErrorCode(error) ?? "") && failureCount < 3,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

// Server renders must not share a QueryClient across requests; the browser
// must reuse one across suspense re-renders.
function getQueryClient() {
  if (typeof window === "undefined") return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const queryClient = getQueryClient();
  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: "/api/trpc", transformer: superjson })],
    }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
