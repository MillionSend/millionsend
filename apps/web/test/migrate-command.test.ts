import { describe, expect, it } from "vitest";
import { migrateCommand } from "@/lib/migrate-command";

describe("migrateCommand", () => {
  it("cloud: the bare one-liner", () => {
    expect(migrateCommand(null)).toBe("npx @millionsend/cli migrate --from resend");
  });

  it("self-hosted: names the instance's API URL", () => {
    expect(migrateCommand("https://api.acme.dev")).toBe(
      "npx @millionsend/cli migrate --from resend --to-url https://api.acme.dev",
    );
  });
});
