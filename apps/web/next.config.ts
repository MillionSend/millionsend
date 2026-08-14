import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const config: NextConfig = {
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
