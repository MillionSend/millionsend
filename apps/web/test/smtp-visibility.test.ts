import { afterEach, expect, it, vi } from "vitest";
import { smtpRelayOffered } from "@/server/smtp";

// "" rather than "false": under SKIP_ENV_VALIDATION the env proxy carries raw
// strings, where "false" would be truthy.
function cloud(overrides: Record<string, string> = {}) {
  vi.stubEnv("IS_CLOUD", "true");
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
}

const EXPOSED = {
  SMTP_TLS_CERT_PATH: "/certs/fullchain.pem",
  SMTP_TLS_KEY_PATH: "/certs/privkey.pem",
  SMTP_PUBLIC_HOST: "smtp.example.com",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

it("always offers the relay on self-host, so the operator can see what is missing", () => {
  vi.stubEnv("IS_CLOUD", "");
  expect(smtpRelayOffered()).toBe(true);
});

it("offers the relay on cloud once it has a keypair and a public host", () => {
  cloud(EXPOSED);
  expect(smtpRelayOffered()).toBe(true);
});

it("hides the relay on cloud when the keypair is missing (the relay cannot start)", () => {
  cloud({ ...EXPOSED, SMTP_TLS_CERT_PATH: "", SMTP_TLS_KEY_PATH: "" });
  expect(smtpRelayOffered()).toBe(false);
});

// Without the override the host falls back to APP_BASE_URL's hostname, which
// fronts HTTP and never answers on the relay port.
it("hides the relay on cloud when no public host names where it answers", () => {
  cloud({ ...EXPOSED, SMTP_PUBLIC_HOST: "" });
  expect(smtpRelayOffered()).toBe(false);
});
