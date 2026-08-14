import { describe, expect, it } from "vitest";
import { maskApiKey } from "@/lib/format";

describe("maskApiKey", () => {
  it("masks everything after the scheme, keeping the last 4", () => {
    expect(maskApiKey("ms_live_abc123", "wxyz")).toBe("ms_live_••••••••wxyz");
    expect(maskApiKey("ms_test_abc123", "wxyz")).toBe("ms_test_••••••••wxyz");
  });

  it("is unaffected by underscores inside the base64url secret chars", () => {
    expect(maskApiKey("ms_live_ab_c1d", "wxyz")).toBe("ms_live_••••••••wxyz");
    expect(maskApiKey("ms_test__a_b_c", "wxyz")).toBe("ms_test_••••••••wxyz");
  });

  it("falls back to the whole prefix when the scheme is unrecognized", () => {
    expect(maskApiKey("legacy", "wxyz")).toBe("legacy••••••••wxyz");
  });
});
