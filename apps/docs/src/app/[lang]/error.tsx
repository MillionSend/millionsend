"use client";

import Link from "next/link";

// Segment error boundary: rendered inside DocsLayout, so navigation survives
// a page that throws. English only, like the 404. Same rhythm as the
// dashboard's .ms-status and the LP's .lp-status.
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-24 text-center">
      <div className="font-extrabold text-[clamp(64px,12vw,96px)] text-fd-foreground leading-none tabular-nums tracking-[-0.01em]">
        500
      </div>
      <h1 className="font-[Erode,Georgia,serif] font-medium text-[28px] text-fd-foreground leading-[1.1] tracking-[-0.02em]">
        Something broke.
      </h1>
      <p className="max-w-[440px] text-[15px] text-fd-muted-foreground">
        The error is on our side. Reload, or try again in a moment.
      </p>
      <div className="mt-2 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="inline-flex h-[30px] items-center rounded-md bg-fd-primary px-2.5 font-semibold text-fd-primary-foreground text-sm hover:opacity-[.88]"
        >
          Try again
        </button>
        <Link
          href="/"
          className="inline-flex h-[30px] items-center rounded-md border border-fd-border bg-fd-accent px-2.5 font-semibold text-fd-foreground text-sm hover:opacity-[.88]"
        >
          Go to the docs
        </Link>
      </div>
    </div>
  );
}
