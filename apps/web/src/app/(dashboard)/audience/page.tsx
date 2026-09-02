import { isCloudDeployment } from "@millionsend/config";
import { apiBaseUrl } from "@/lib/api-base-url";
import { AudienceContactsView } from "./contacts-view";

export default function AudiencePage() {
  return <AudienceContactsView migrateToUrl={isCloudDeployment() ? null : apiBaseUrl()} />;
}
