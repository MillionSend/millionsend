import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const config: NextConfig = {
  poweredByHeader: false,
  // Required at runtime, not bundled per route: instrumentation starts the
  // one SDK instance that every route then reports through.
  serverExternalPackages: ["@sentry/node"],
  experimental: {
    // Keep visited page segments in the client router cache so sidebar
    // back-and-forth doesn't refetch RSC payloads every click. Safe at 30s:
    // dashboard pages are "use client" shells whose data flows through
    // react-query (its own freshness rules). Cached layouts do carry the
    // session's outcome (team, email, a redirect to /login), prefetched ones
    // for the full `static` 180 s, which is why sign-in and sign-out are
    // document loads that start this cache empty.
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
        ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com"
        : "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com";
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
      // Turnstile renders its challenge in a Cloudflare frame.
      "frame-src https://challenges.cloudflare.com",
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

/**
 * Browser source maps go to the error tracker only from a build that carries
 * SENTRY_AUTH_TOKEN (with SENTRY_URL, SENTRY_ORG and SENTRY_PROJECT). They
 * are matched by debug id and deleted once uploaded, so the image never
 * serves them. Build phase only: the plugin is a dev dependency, absent from
 * the image `next start` runs in.
 */
async function withSourceMapUpload(base: NextConfig): Promise<NextConfig> {
  const authToken = process.env.SENTRY_AUTH_TOKEN;
  if (!authToken) return base;
  const { sentryWebpackPlugin } = await import("@sentry/bundler-plugins/webpack");
  return {
    ...base,
    productionBrowserSourceMaps: true,
    webpack: (webpackConfig, context) => {
      const result = base.webpack ? base.webpack(webpackConfig, context) : webpackConfig;
      if (!context.isServer && !context.dev) {
        result.devtool = "hidden-source-map";
        result.plugins.push(
          sentryWebpackPlugin({
            authToken,
            telemetry: false,
            // Each event already names its release, so the upload never calls the release API, which some trackers lack.
            release: { create: false, finalize: false, inject: false },
            sourcemaps: { filesToDeleteAfterUpload: [".next/static/**/*.map"] },
          }),
        );
      }
      return result;
    },
  };
}

export default async (phase: string) =>
  withNextIntl(phase === PHASE_PRODUCTION_BUILD ? await withSourceMapUpload(config) : config);
