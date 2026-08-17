import { loader } from "fumadocs-core/source";
import { openapiPlugin } from "fumadocs-openapi/server";
import { docs } from "../../.source/server";

export const source = loader({
  baseUrl: "/",
  source: docs.toFumadocsSource(),
  // Adds HTTP-method badges to generated API reference pages in the page tree.
  plugins: [openapiPlugin()],
});
