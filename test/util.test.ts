import { describe, expect, test } from "bun:test";
import { isUsableSecret, splitModelRoleValue } from "../src/util";

describe("isUsableSecret", () => {
  test("rejects CC Switch bullet placeholders", () => {
    expect(isUsableSecret("••••••••••••••••")).toBe(false);
  });

  test("accepts real-looking keys", () => {
    expect(isUsableSecret("sk-test-key-12345")).toBe(true);
  });
});

describe("splitModelRoleValue", () => {
  test("preserves max thinking suffix", () => {
    expect(splitModelRoleValue("ccs-codex-bailian/deepseek-v4-flash-0731:max")).toEqual({
      base: "ccs-codex-bailian/deepseek-v4-flash-0731",
      suffix: ":max",
    });
  });

  test("ignores colons that are not effort suffixes", () => {
    expect(splitModelRoleValue("provider/weird:id:still-model")).toEqual({
      base: "provider/weird:id:still-model",
      suffix: "",
    });
  });
});
