import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

export type BridgedThinking = NonNullable<ProviderModelConfig["thinking"]>;

function effort(...levels: string[]): BridgedThinking {
  return { mode: "effort", efforts: levels as unknown as BridgedThinking["efforts"] };
}

function parseGlmVersion(modelId: string): number | null {
  const m = /\bglm[-_.]?(\d+(?:\.\d+)?)/i.exec(modelId);
  return m ? Number.parseFloat(m[1]) : null;
}

function isReasoningGlm(modelId: string): boolean {
  const version = parseGlmVersion(modelId);
  return version !== null && version >= 4.5;
}

function isGlm52Plus(modelId: string): boolean {
  const version = parseGlmVersion(modelId);
  return version !== null && version >= 5.2;
}

function isKimiK3(modelId: string): boolean {
  return /kimi[-_.]?k3/i.test(modelId);
}

function isGpt56Plus(modelId: string): boolean {
  const m = /\bgpt[-_.]?(\d+(?:\.\d+)?)/i.exec(modelId);
  if (!m) return false;
  return Number.parseFloat(m[1]) >= 5.6;
}

/**
 * Pin wire-exact thinking ladders on CC Switch bridged models so omp does not
 * fall back to catalog inference (which often caps openai-responses at xhigh).
 */
export function inferBridgedThinking(modelId: string, api: string): BridgedThinking | undefined {
  const id = modelId.toLowerCase();

  if (/deepseek-v4-flash/i.test(id)) {
    return effort("low", "high", "max");
  }
  if (/deepseek-v4/i.test(id)) {
    return effort("high", "max");
  }
  if (/deepseek/i.test(id) && (api === "openai-responses" || api === "openai-completions")) {
    return effort("high", "max");
  }

  if (isKimiK3(modelId)) {
    return effort("low", "high", "max");
  }

  if (isGlm52Plus(modelId)) {
    if (api === "anthropic-messages") {
      return effort("high", "max");
    }
    if (
      api === "openai-responses" ||
      api === "openai-completions" ||
      api === "openai-codex-responses" ||
      api === "azure-openai-responses"
    ) {
      return effort("minimal", "low", "medium", "high", "max");
    }
  }

  if (isReasoningGlm(modelId) && (api === "openai-responses" || api === "openai-completions")) {
    return effort("minimal", "low", "medium", "high", "max");
  }

  if (
    isGpt56Plus(modelId) &&
    (api === "openai-responses" || api === "openai-codex-responses" || api === "azure-openai-responses")
  ) {
    return effort("low", "medium", "high", "xhigh", "max");
  }

  return undefined;
}
