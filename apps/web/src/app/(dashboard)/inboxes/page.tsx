import { receivingEnabled } from "@millionsend/config";
import { notFound } from "next/navigation";
import { InboxesView } from "./inboxes-view";

export default function InboxesPage() {
  // An instance that takes no mail has no inboxes: not hidden, absent.
  if (!receivingEnabled()) notFound();
  return <InboxesView />;
}
