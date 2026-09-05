import { createMDX } from "fumadocs-mdx/next";

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Content pages are prerendered with dynamicParams = false, so an unknown
  // URL never reaches [lang]/not-found; the global page answers it instead.
  experimental: { globalNotFound: true },
  async rewrites() {
    return [
      // Agent-readable markdown: appending .md to any content page URL serves
      // the page's markdown source (handled by app/llms.mdx/[[...slug]]).
      { source: "/:path*.md", destination: "/llms.mdx/:path*" },
    ];
  },
  async headers() {
    const scriptPolicy =
      process.env.NODE_ENV === "development"
        ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
        : "script-src 'self' 'unsafe-inline'";
    const contentSecurityPolicy = [
      "default-src 'self'",
      scriptPolicy,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self'",
      // The API playground calls the hosted API straight from the browser.
      "connect-src 'self' https://api.millionsend.com",
      "object-src 'none'",
      "frame-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
      {
        // Prerendered pages otherwise carry Next's one-year s-maxage, which a
        // cache-everything CDN rule would pin (404s included). Hashed /_next
        // assets keep their own immutable header.
        source: "/((?!_next/).*)",
        headers: [{ key: "Cache-Control", value: "s-maxage=300, stale-while-revalidate=86400" }],
      },
    ];
  },
};

const withMDX = createMDX();

export default withMDX(config);
