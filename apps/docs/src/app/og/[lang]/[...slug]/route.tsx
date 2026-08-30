import { generateOGImage } from "fumadocs-ui/og";
import { notFound } from "next/navigation";
import { source } from "@/lib/source";

export const revalidate = false;
// Unknown slugs 404 statically; on-demand rendering would try to persist the
// result into .next, which fails on a read-only rootfs.
export const dynamicParams = false;

// URL shape: /og/<lang>/<...slugs>/image.png — the extension keeps the path
// out of the i18n proxy, which only handles extension-less page URLs.
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ lang: string; slug: string[] }> },
): Promise<Response> {
  const { lang, slug } = await ctx.params;
  const page = source.getPage(slug.slice(0, -1), lang);
  if (!page) notFound();

  return generateOGImage({
    title: page.data.title,
    description: page.data.description,
    site: "MillionSend Docs",
    primaryColor: "#7F8791",
    primaryTextColor: "#F4F1EA",
  });
}

export function generateStaticParams() {
  return source
    .getLanguages()
    .flatMap(({ language, pages }) =>
      pages.map((page) => ({ lang: language, slug: [...page.slugs, "image.png"] })),
    );
}
