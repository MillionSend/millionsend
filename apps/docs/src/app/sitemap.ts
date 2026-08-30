import type { MetadataRoute } from "next";
import { absoluteUrl, isTranslated, translations } from "@/lib/site";
import { source } from "@/lib/source";

export default function sitemap(): MetadataRoute.Sitemap {
  return source.getLanguages().flatMap(({ pages }) =>
    pages.filter(isTranslated).map((page) => ({
      url: absoluteUrl(page.url),
      alternates: { languages: translations(page) },
    })),
  );
}
