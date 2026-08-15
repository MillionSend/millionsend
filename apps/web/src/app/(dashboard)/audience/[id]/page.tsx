"use client";

import { useParams } from "next/navigation";
import { AudienceContactsView } from "../contacts-view";

/** Canonical per-audience URL: the Contacts surface for the audience in the path. */
export default function AudienceContactsPage() {
  const { id } = useParams<{ id: string }>();
  // Keyed so navigating between audiences resets search/filter/paging state.
  return <AudienceContactsView key={id} audienceId={id} />;
}
