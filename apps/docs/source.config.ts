import { defineConfig, defineDocs } from "fumadocs-mdx/config";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    // Raw-markdown surfaces (/llms.txt, /llms-full.txt, *.md routes) read the
    // processed markdown of every page; without this option getText("processed")
    // throws at runtime.
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

export default defineConfig();
