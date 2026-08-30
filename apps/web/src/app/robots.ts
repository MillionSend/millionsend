import type { MetadataRoute } from "next";

// The dashboard is private; only the auth entry points are worth a search
// result. Pages inherit noindex from the root layout, which login and signup
// override.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: ["/login", "/signup"], disallow: "/" } };
}
