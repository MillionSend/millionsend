import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "@/styles/globals.css";
import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: "MillionSend",
  icons: { icon: "/logo/millionsend-favicon.svg" },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale}>
      <body className="ms">
        {/* Erode loads from the Fontshare CDN — the Fontshare EULA forbids
            vendoring the font files into this repository. */}
        <link
          rel="stylesheet"
          href="https://api.fontshare.com/v2/css?f[]=erode@500&display=swap"
          precedence="default"
        />
        <NextIntlClientProvider>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
