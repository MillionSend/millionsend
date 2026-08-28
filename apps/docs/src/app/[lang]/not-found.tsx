import Link from "next/link";

// Rendered inside DocsLayout, so the sidebar and search stay usable from a
// dead link. English only: 404s have no locale segment of their own.
export default function NotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-24 text-center">
      <p className="font-mono text-sm text-fd-muted-foreground">404</p>
      <h1 className="text-2xl font-semibold text-fd-foreground">No such page.</h1>
      <p className="max-w-md text-sm text-fd-muted-foreground">
        Wrong address, or the page moved. The sidebar has everything that exists.
      </p>
      <Link
        href="/"
        className="rounded-md border border-fd-border px-4 py-2 text-sm text-fd-foreground hover:bg-fd-accent"
      >
        Docs home
      </Link>
    </div>
  );
}
