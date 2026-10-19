import { AwsCredentialsBanner } from "./aws-credentials-banner";
import { DomainsView } from "./domains-table";

export default function DomainsPage() {
  return <DomainsView awsBanner={<AwsCredentialsBanner />} />;
}
