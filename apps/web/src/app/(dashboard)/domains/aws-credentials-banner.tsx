import { isCloudDeployment } from "@millionsend/config";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { codeRichTags } from "@/lib/code-rich-tags";
import { awsCredentialsConfigured } from "@/server/system-mail";

/**
 * Warn-only banner shown while no explicit AWS credentials are configured.
 * Submits stay allowed: the default provider chain may still supply
 * credentials at runtime, so this informs rather than blocks.
 */
export async function AwsCredentialsBanner() {
  if (isCloudDeployment() || awsCredentialsConfigured()) return null;
  const t = await getTranslations("domains");
  return (
    <div
      role="status"
      style={{
        border: "1px solid var(--ms-warn-border)",
        background: "var(--ms-warn-bg)",
        borderRadius: "var(--ms-r-input)",
        padding: "9px 14px",
        marginBottom: 18,
        fontSize: 13,
        lineHeight: 1.5,
        color: "var(--ms-warn)",
        maxWidth: 1000,
        display: "flex",
        alignItems: "center",
        gap: 14,
      }}
    >
      <span style={{ flex: 1 }}>{t.rich("awsCredentialsWarning", codeRichTags)}</span>
      <Link href="/settings/ses" className="ms-btn ms-btn-secondary" style={{ flex: "none" }}>
        {t("awsCredentialsCta")}
      </Link>
    </div>
  );
}
