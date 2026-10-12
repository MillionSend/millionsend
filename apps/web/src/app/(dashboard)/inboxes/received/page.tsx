import { receivingEnabled } from "@millionsend/config";
import { notFound } from "next/navigation";
import { ReceivedView } from "./received-view";

export default function ReceivedPage() {
  if (!receivingEnabled()) notFound();
  return <ReceivedView />;
}
