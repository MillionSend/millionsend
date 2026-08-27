import { env } from "@millionsend/config";
import { smtpRelayOffered } from "@/server/smtp";
import { SettingsTabsNav } from "./settings-tabs-nav";

/** Billing exists only on the hosted cloud; self-host never shows the tab. */
export function SettingsTabs() {
  return <SettingsTabsNav showBilling={env.IS_CLOUD} showSmtp={smtpRelayOffered()} />;
}
