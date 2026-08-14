import { getDb } from "@millionsend/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/server/auth";
import { getActiveMembership } from "@/server/membership";
import { OnboardingForm } from "./onboarding-form";

export default async function OnboardingPage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  const membership = await getActiveMembership(getDb(), session.user.id);
  if (membership) redirect("/emails");
  return <OnboardingForm />;
}
