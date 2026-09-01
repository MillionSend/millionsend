import { TrackingOnboarding } from "./tracking-onboarding";

export default async function TrackingOnboardingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TrackingOnboarding id={id} />;
}
