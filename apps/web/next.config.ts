import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const config: NextConfig = {
  poweredByHeader: false,
  experimental: {
    // Keep visited page segments in the client router cache so sidebar
    // back-and-forth doesn't refetch RSC payloads every click. Safe at 30s:
    // dashboard pages are "use client" shells whose data flows through
    // react-query (its own freshness rules) — the cached payload holds no
    // user data that could go stale.
    staleTimes: { dynamic: 30, static: 180 },
  },
  async redirects() {
    return [
      {
        source: "/llms-full.txt",
        destination: "https://docs.millionsend.com/llms-full.txt",
        permanent: true,
      },
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
      // Team logos are served from S3_STORAGE_PUBLIC_URL, a runtime value this
      // build-time policy cannot name; images carry no script, so any https
      // origin is acceptable.
      "img-src 'self' data: blob: https:",
      "font-src 'self'",
      "connect-src 'self'",
      "media-src 'self'",
      "object-src 'none'",
      "frame-src 'none'",
      "worker-src 'self' blob:",
      "manifest-src 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Browsers only honour HSTS over https, so plain-http self-hosts
          // are unaffected; no preload until every subdomain is TLS-clean.
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
  // Workspace packages ship TS source with NodeNext-style "./file.js"
  // relative imports. Resolving those needs webpack's extensionAlias;
  // Turbopack has no equivalent yet (vercel/next.js#82945, checked
  // 2026-08), so dev/build scripts pass --webpack.
  transpilePackages: [
    "@millionsend/config",
    "@millionsend/core",
    "@millionsend/db",
    "@millionsend/ses",
  ],
  webpack: (webpackConfig) => {
    webpackConfig.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return webpackConfig;
  },
};

export default withNextIntl(config);
