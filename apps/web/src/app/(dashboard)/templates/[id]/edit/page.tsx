"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { parseBlockDoc } from "@/lib/email-blocks/model";
import { useTRPC } from "@/lib/trpc";
import { EditorSkeleton, TemplateEditor } from "../../editor";

export default function EditTemplatePage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations("templates");
  const trpc = useTRPC();

  const query = useQuery(trpc.templates.get.queryOptions({ id }, { retry: false }));
  const template = query.data;

  if (query.isError) {
    return (
      <>
        <p style={{ color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
          {t("editor.notFound")}
        </p>
        <Link href="/templates" style={{ fontSize: "var(--ms-fs-ui)" }}>
          ← {t("list.title")}
        </Link>
      </>
    );
  }
  if (!template) return <EditorSkeleton />;

  return (
    <TemplateEditor
      initial={{
        id: template.id,
        name: template.name,
        subject: template.subject,
        html: template.html,
        text: template.text,
        document: parseBlockDoc(template.document),
      }}
    />
  );
}
