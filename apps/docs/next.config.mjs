import { createMDX } from "fumadocs-mdx/next";

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  async rewrites() {
    return [
      // Agent-readable markdown: appending .md to any content page URL serves
      // the page's markdown source (handled by app/llms.mdx/[[...slug]]).
      { source: "/:path*.md", destination: "/llms.mdx/:path*" },
    ];
  },
};

const withMDX = createMDX();

export default withMDX(config);
