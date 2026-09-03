import { env } from "@millionsend/config";
import { smtpRelayOffered } from "@/server/smtp";
import { SettingsTabsNav } from "./settings-tabs-nav";

/** Billing exists only on the hosted cloud; the SES setup (the instance's own
 * AWS account) only off it. Self-host never shows the former, cloud never the latter. */
export function SettingsTabs() {
  return (
    <SettingsTabsNav
      showBilling={env.IS_CLOUD}
      showSes={!env.IS_CLOUD}
      showSmtp={smtpRelayOffered()}
    />
  );
}
