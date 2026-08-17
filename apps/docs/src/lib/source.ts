import { loader } from "fumadocs-core/source";
import { openapiPlugin } from "fumadocs-openapi/server";
import { docs } from "../../.source/server";
import { i18n } from "./i18n";

export const source = loader({
  baseUrl: "/",
  source: docs.toFumadocsSource(),
  // Locale variants use the dot convention (page.pt-BR.mdx, meta.pt-BR.json).
  i18n,
  // Adds HTTP-method badges to generated API reference pages in the page tree.
  plugins: [openapiPlugin()],
});
