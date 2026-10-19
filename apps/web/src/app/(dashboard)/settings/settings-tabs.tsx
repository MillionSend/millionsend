import { env, receivingEnabled } from "@millionsend/config";
import { getDb } from "@millionsend/db";
import { headers } from "next/headers";
import { getAuth } from "@/server/auth";
import { isInstanceOperator } from "@/server/instance-operator";
import { smtpRelayOffered } from "@/server/smtp";
import { SettingsTabsNav } from "./settings-tabs-nav";

/** Billing exists only on the hosted cloud; the SES setup (the instance's own
 * AWS account) only off it. Self-host never shows the former, cloud never the latter. */
export async function SettingsTabs() {
  const session = receivingEnabled()
    ? await getAuth().api.getSession({ headers: await headers() })
    : null;
  return (
    <SettingsTabsNav
      showBilling={env.IS_CLOUD}
      showSes={!env.IS_CLOUD}
      showSmtp={smtpRelayOffered()}
      showReceiving={session !== null && (await isInstanceOperator(getDb(), session.user.id))}
    />
  );
}
