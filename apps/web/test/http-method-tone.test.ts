import { describe, expect, it } from "vitest";
import { httpMethodTone } from "../src/lib/http-method-tone";

describe("httpMethodTone", () => {
  it("follows Postman's palette: GET green, POST yellow, PUT blue, PATCH purple, DELETE red", () => {
    expect(httpMethodTone("GET")).toBe("success");
    expect(httpMethodTone("POST")).toBe("warn");
    expect(httpMethodTone("PUT")).toBe("info");
    expect(httpMethodTone("PATCH")).toBe("violet");
    expect(httpMethodTone("DELETE")).toBe("danger");
    expect(httpMethodTone("HEAD")).toBe("success");
    expect(httpMethodTone("OPTIONS")).toBe("pink");
  });

  it("is case-insensitive and neutral for anything else", () => {
    expect(httpMethodTone("post")).toBe("warn");
    expect(httpMethodTone("TRACE")).toBe("neutral");
  });
});
