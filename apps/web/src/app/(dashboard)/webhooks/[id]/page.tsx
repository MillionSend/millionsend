import { WebhookDetail } from "./webhook-detail";

export default async function WebhookDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WebhookDetail id={id} />;
}
