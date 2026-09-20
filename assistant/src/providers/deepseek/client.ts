import {
  modelEffortCeilings,
  modelSupportedEfforts,
} from "../model-catalog.js";
import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";

export interface DeepSeekProviderOptions {
  apiKey?: string;
  baseURL?: string;
  streamTimeoutMs?: number;
}

/**
 * DeepSeek's own API, which speaks OpenAI chat-completions.
 *
 * The managed route sets `baseURL` to the platform's
 * `/v1/runtime-proxy/deepseek` path and authenticates with the assistant API
 * key; a direct install points at DeepSeek and uses its own key.
 */
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";

const DEEPSEEK_MODEL_EFFORT_CEILINGS = modelEffortCeilings("deepseek");
const DEEPSEEK_MODEL_SUPPORTED_EFFORTS = modelSupportedEfforts("deepseek");

export class DeepSeekProvider extends OpenAIChatCompletionsProvider {
  constructor(
    apiKey: string,
    model: string,
    options: DeepSeekProviderOptions = {},
  ) {
    super(apiKey, model, {
      baseURL: options.baseURL?.trim() || DEFAULT_DEEPSEEK_BASE_URL,
      providerName: "deepseek",
      providerLabel: "DeepSeek",
      streamTimeoutMs: options.streamTimeoutMs,
      maxReasoningEffort: "high",
      // DeepSeek reports its chain of thought on this field rather than in
      // the message content, the same way Fireworks' DeepSeek builds do.
      assistantReasoningField: "reasoning_content",
    });
  }

  protected override resolveMaxReasoningEffort(
    model: string,
  ): "high" | "xhigh" | "max" {
    return DEEPSEEK_MODEL_EFFORT_CEILINGS.get(model) ?? "high";
  }

  protected override resolveSupportedReasoningEfforts(model: string) {
    return DEEPSEEK_MODEL_SUPPORTED_EFFORTS.get(model);
  }
}
