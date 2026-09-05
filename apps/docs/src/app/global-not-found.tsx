import "./global.css";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import { NotFoundPanel } from "@/components/not-found-panel";

export const metadata: Metadata = { title: "Page not found · MillionSend Docs" };

/**
 * Every content page is prerendered (dynamicParams = false), so a URL that
 * matches no page never reaches [lang]/not-found: Next answers it at the
 * router with this document instead. It bypasses the layout, hence its own
 * <html>, the stylesheet import and its own RootProvider, so the reader's
 * stored theme still applies. No search: the page has nothing to open it.
 */
export default function GlobalNotFound() {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col bg-fd-background text-fd-foreground">
        <RootProvider theme={{ defaultTheme: "dark" }} search={{ enabled: false }}>
          <NotFoundPanel />
        </RootProvider>
      </body>
    </html>
  );
}
