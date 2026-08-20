import { TopicDetail } from "./topic-detail";

export default async function TopicDetailPage({
  params,
}: {
  params: Promise<{ topicId: string }>;
}) {
  const { topicId } = await params;
  return <TopicDetail id={topicId} />;
}
