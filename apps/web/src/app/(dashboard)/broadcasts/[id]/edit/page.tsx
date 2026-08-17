"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { useTRPC } from "@/lib/trpc";
import { BroadcastComposer, ComposerSkeleton } from "../../composer";

export default function EditBroadcastPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations("broadcasts");
  const trpc = useTRPC();
  const router = useRouter();

  const query = useQuery(trpc.broadcasts.get.queryOptions({ id }, { retry: false }));
  const broadcast = query.data;
  const editable = broadcast?.status === "draft";

  // Only drafts are editable; anything else lands on its detail page.
  useEffect(() => {
    if (broadcast && !editable) router.replace(`/broadcasts/${id}`);
  }, [broadcast, editable, router, id]);

  if (query.isError) {
    return (
      <>
        <p style={{ color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
          {t("detail.notFound")}
        </p>
        <Link href="/broadcasts" style={{ fontSize: "var(--ms-fs-ui)" }}>
          ← {t("list.title")}
        </Link>
      </>
    );
  }
  if (!broadcast || !editable) return <ComposerSkeleton />;

  return (
    <BroadcastComposer
      initial={{
        id: broadcast.id,
        topicId: broadcast.topicId,
        segmentId: broadcast.segmentId,
        name: broadcast.name,
        from: broadcast.from,
        subject: broadcast.subject,
        replyTo: broadcast.replyTo,
        html: broadcast.html,
        text: broadcast.text,
        document: broadcast.document,
      }}
    />
  );
}
