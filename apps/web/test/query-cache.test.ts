import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MutationObserver, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { makeQueryClient } from "@/components/providers";

const src = fileURLToPath(new URL("../src", import.meta.url));
const sources = readdirSync(src, { recursive: true, encoding: "utf8" })
  .filter((file) => /\.tsx?$/.test(file))
  .map((file) => ({ file, text: readFileSync(join(src, file), "utf8") }));
const hits = (pattern: RegExp) =>
  sources.flatMap(({ file, text }) => (text.match(pattern) ?? []).map((hit) => `${file}: ${hit}`));

describe("query cache", () => {
  it("marks every query stale after a successful write and refetches none", async () => {
    const client = makeQueryClient();
    client.setQueryData(["on-screen"], "stored");
    const queryFn = vi.fn(async () => "refetched");
    const unsubscribe = new QueryObserver(client, { queryKey: ["on-screen"], queryFn }).subscribe(
      () => {},
    );
    await new MutationObserver(client, { mutationFn: async () => "saved" }).mutate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.getQueryState(["on-screen"])?.isInvalidated).toBe(true);
    expect(queryFn).not.toHaveBeenCalled();
    unsubscribe();
  });

  // queryKey() and queryFilter() are tagged type "query", which never matches the "infinite"
  // entry infiniteQueryOptions caches; pathFilter() carries no type and matches both.
  it("refreshes an infinite list only through a filter that can match it", () => {
    const paths = new Set(
      sources.flatMap(({ text }) =>
        [...text.matchAll(/trpc\.([\w.]+)\.infiniteQueryOptions\(/g)].map((m) => m[1]),
      ),
    );
    const typed = new RegExp(
      `trpc\\.(?:${[...paths].join("|").replaceAll(".", "\\.")})\\.(?:queryKey|queryFilter)\\(`,
      "g",
    );
    expect(hits(typed)).toEqual([]);
    // A hand-built infinite query keyed as the plain query would share its cache entry.
    expect(hits(/useInfiniteQuery\(\{\s*queryKey:\s*trpc\./g)).toEqual([]);
  });

  it("never remounts a form on a refetch", () => {
    // dataUpdatedAt moves on every successful fetch, identical data included.
    expect(hits(/key=\{[^}]*dataUpdatedAt/g)).toEqual([]);
  });
});
