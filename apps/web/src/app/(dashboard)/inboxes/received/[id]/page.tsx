import { receivingEnabled } from "@millionsend/config";
import { notFound } from "next/navigation";
import { ReceivedEmailView } from "./received-email";

export default function ReceivedEmailPage() {
  if (!receivingEnabled()) notFound();
  return <ReceivedEmailView />;
}
