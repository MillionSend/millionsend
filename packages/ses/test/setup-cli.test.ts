import { describe, expect, it } from "vitest";
import { authAction } from "../src/setup-cli.js";

describe("authAction", () => {
  it("proceeds when the identity check passed", () => {
    expect(authAction({ identityOk: true, hasAwsCli: false, isTTY: false })).toBe("proceed");
  });

  it("offers a login only on a TTY with the aws CLI present", () => {
    expect(authAction({ identityOk: false, hasAwsCli: true, isTTY: true })).toBe("offer-login");
  });

  it("hints and exits on pipes even with the aws CLI present", () => {
    expect(authAction({ identityOk: false, hasAwsCli: true, isTTY: false })).toBe("hint-exit");
  });

  it("hints and exits on a TTY without the aws CLI", () => {
    expect(authAction({ identityOk: false, hasAwsCli: false, isTTY: true })).toBe("hint-exit");
  });
});
