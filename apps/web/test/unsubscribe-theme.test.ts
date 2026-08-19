import { describe, expect, it } from "vitest";
import { contrastTextColor, isHexColor } from "@/lib/hex-color";
import { unsubscribeAccentStyle, unsubscribeThemeStyle } from "@/lib/unsubscribe-theme";

describe("isHexColor", () => {
  it("accepts strict 6-digit hex in any case", () => {
    for (const value of ["#000000", "#ffffff", "#46A3f9", "#1a2B3c"]) {
      expect(isHexColor(value)).toBe(true);
    }
  });

  it("rejects everything else", () => {
    const bad = [
      "",
      "red",
      "#fff",
      "#12345g",
      "46a3f9",
      "#1234567",
      "rgb(0,0,0)",
      "#12345",
      "url(x)",
      "#46a3f9 ",
    ];
    for (const value of bad) {
      expect(isHexColor(value)).toBe(false);
    }
  });
});

describe("contrastTextColor", () => {
  it("picks white on dark and black on light", () => {
    expect(contrastTextColor("#000000")).toBe("#ffffff");
    expect(contrastTextColor("#1a1a2e")).toBe("#ffffff");
    expect(contrastTextColor("#ffffff")).toBe("#000000");
    expect(contrastTextColor("#f4f1ea")).toBe("#000000");
  });
});

describe("unsubscribeThemeStyle", () => {
  it("maps valid colors onto background and token overrides", () => {
    const style = unsubscribeThemeStyle({
      backgroundColor: "#101010",
      textColor: "#f0f0f0",
      accentColor: null,
    }) as Record<string, string>;
    expect(style.background).toBe("#101010");
    expect(style["--ms-bone"]).toBe("#f0f0f0");
    expect(style["--ms-panel"]).toContain("#101010");
    expect(style["--ms-muted"]).toContain("#f0f0f0");
  });

  it("drops anything that is not a strict hex — the last boundary before inline styles", () => {
    expect(
      unsubscribeThemeStyle({
        backgroundColor: "url(javascript:x)",
        textColor: "#fff;background:red",
        accentColor: null,
      }),
    ).toEqual({});
  });

  it("themes each color independently", () => {
    const style = unsubscribeThemeStyle({
      backgroundColor: null,
      textColor: "#222222",
      accentColor: null,
    }) as Record<string, string>;
    expect(style.background).toBeUndefined();
    expect(style["--ms-bone"]).toBe("#222222");
  });
});

describe("unsubscribeAccentStyle", () => {
  it("returns button colors for a valid accent and undefined otherwise", () => {
    expect(unsubscribeAccentStyle("#46a3f9")).toEqual({
      background: "#46a3f9",
      color: "#000000",
    });
    expect(unsubscribeAccentStyle(null)).toBeUndefined();
    expect(unsubscribeAccentStyle("expression(alert(1))")).toBeUndefined();
  });
});
