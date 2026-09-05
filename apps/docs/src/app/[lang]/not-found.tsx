import { NotFoundPanel } from "@/components/not-found-panel";

// Reached by notFound() from a page under a known locale: DocsLayout stays
// around it, so the sidebar and search remain usable from a dead link.
export default function NotFound() {
  return <NotFoundPanel />;
}
