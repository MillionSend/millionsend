import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "@/styles/globals.css";
import { env } from "@millionsend/config";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { Providers } from "@/components/providers";
import { THEME_INIT_SCRIPT, THEME_KEY } from "@/lib/theme";

// metadataBase comes from the runtime APP_BASE_URL, so a self-hosted instance
// emits its own absolute Open Graph URLs rather than ours. Copy mirrors the
// LP's meta (millionsend-lp src/messages) so a shared app link reads the same
// as the site's; keep the two in step.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common");
  return {
    ...(env.APP_BASE_URL ? { metadataBase: new URL(env.APP_BASE_URL) } : {}),
    title: { default: t("appName"), template: `%s · ${t("appName")}` },
    description: t("meta.description"),
    // Everything behind the sign-in is private; the auth pages opt back in.
    robots: { index: false, follow: false },
    icons: { icon: "/logo/millionsend-favicon.svg" },
    openGraph: {
      siteName: t("appName"),
      type: "website",
      title: t("meta.title"),
      description: t("meta.description"),
      images: [{ url: "/og.png", width: 1280, height: 640, alt: t("appName") }],
    },
    twitter: { card: "summary_large_image" },
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  // Cookie mirror of the localStorage preference lets SSR paint the right
  // theme; the inline script below corrects any stale cookie pre-paint.
  const theme = (await cookies()).get(THEME_KEY)?.value;
  return (
    <html
      lang={locale}
      {...(theme === "light" ? { "data-theme": "light" } : {})}
      suppressHydrationWarning
    >
      <body className="ms">
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static theme bootstrap, no user input */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <NextIntlClientProvider>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
