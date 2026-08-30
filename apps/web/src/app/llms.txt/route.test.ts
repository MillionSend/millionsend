import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import { GET } from "./route";

describe("crawler entry points", () => {
  it("llms.txt points agents at the public docs host", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("https://docs.millionsend.com/llms.txt");
  });

  it("robots keeps crawlers off everything but the auth pages", () => {
    const rules = robots().rules;
    expect(Array.isArray(rules) ? rules[0] : rules).toEqual({
      userAgent: "*",
      allow: ["/login", "/signup"],
      disallow: "/",
    });
  });
});
