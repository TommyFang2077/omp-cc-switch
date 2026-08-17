import { describe, expect, test } from "bun:test";
import { inferBridgedThinking } from "../src/thinking";

function effortLabels(modelId: string, api: string): string[] {
  return (inferBridgedThinking(modelId, api)?.efforts ?? []).map(String);
}

describe("inferBridgedThinking", () => {
  test("DeepSeek V4 Flash exposes low/high/max on openai-responses", () => {
    expect(effortLabels("deepseek-v4-flash-0731", "openai-responses")).toEqual(["low", "high", "max"]);
  });

  test("DeepSeek V4 Pro exposes high/max on openai-responses", () => {
    expect(effortLabels("deepseek-v4-pro-0813", "openai-responses")).toEqual(["high", "max"]);
  });

  test("GLM 5.2 on anthropic-messages exposes high/max", () => {
    expect(effortLabels("glm-5.3", "anthropic-messages")).toEqual(["high", "max"]);
  });

  test("GLM 5.2 on openai-responses exposes max tier above high", () => {
    const efforts = effortLabels("glm-5.2", "openai-responses");
    expect(efforts).toContain("max");
    expect(efforts.indexOf("max")).toBeGreaterThan(efforts.indexOf("high"));
  });

  test("GPT 5.6 exposes xhigh and max on openai-responses", () => {
    expect(effortLabels("gpt-5.6-sol", "openai-responses")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("non-reasoning ids return undefined", () => {
    expect(inferBridgedThinking("qwen-agent", "openai-completions")).toBeUndefined();
  });
});
