import { ReviewView } from "@/components/console/safety/review-view";

export default async function ConsoleSafetyReviewPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  return <ReviewView teamId={teamId} />;
}
