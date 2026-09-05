import Link from "next/link";

/**
 * The 404 in the same rhythm as the dashboard's .ms-status and the LP's
 * .lp-status: the counting-number treatment as hero, one serif sentence, one
 * muted line, the two buttons. English only — 404s have no locale segment.
 * Rendered inside DocsLayout by [lang]/not-found and standalone by
 * global-not-found, so it takes no layout of its own.
 */
export function NotFoundPanel() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-24 text-center">
      <div className="font-extrabold text-[clamp(64px,12vw,96px)] text-fd-foreground leading-none tabular-nums tracking-[-0.01em]">
        404
      </div>
      <h1 className="font-[Erode,Georgia,serif] font-medium text-[28px] text-fd-foreground leading-[1.1] tracking-[-0.02em]">
        No such page.
      </h1>
      <p className="max-w-[440px] text-[15px] text-fd-muted-foreground">
        Wrong address, or the page moved.
      </p>
      <div className="mt-2 flex flex-wrap justify-center gap-3">
        <Link
          href="/"
          className="inline-flex h-[30px] items-center rounded-md bg-fd-primary px-2.5 font-semibold text-fd-primary-foreground text-sm hover:opacity-[.88]"
        >
          Go to the docs
        </Link>
        <a
          href="https://app.millionsend.com"
          className="inline-flex h-[30px] items-center rounded-md border border-fd-border bg-fd-accent px-2.5 font-semibold text-fd-foreground text-sm hover:opacity-[.88]"
        >
          Open the dashboard
        </a>
      </div>
    </div>
  );
}
