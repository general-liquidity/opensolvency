// Model factory over the Vercel AI SDK. The SDK's provider packages are the
// model seam: OpenAI, Anthropic, and Google are wired here, selected by config,
// and none of them touches the gate. Adding another is one case + one package.

import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

export const MODEL_PROVIDERS = ["openai", "anthropic", "google"] as const;
export type ModelProviderName = (typeof MODEL_PROVIDERS)[number];

/** The standard env var each provider reads its key from when none is passed. */
export const PROVIDER_API_KEY_ENV: Record<ModelProviderName, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

/** A sensible cheap/fast default per provider; overridable via config. */
export const DEFAULT_MODEL_ID: Record<ModelProviderName, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5",
  google: "gemini-2.5-flash",
};

export function isModelProvider(value: string): value is ModelProviderName {
  return (MODEL_PROVIDERS as readonly string[]).includes(value);
}

export interface AiModelConfig {
  provider: ModelProviderName;
  modelId: string;
  /** Optional; falls back to the provider's standard env var (above). */
  apiKey?: string;
}

export function createAiModel(cfg: AiModelConfig): LanguageModel {
  switch (cfg.provider) {
    case "openai":
      return createOpenAI({ apiKey: cfg.apiKey })(cfg.modelId);
    case "anthropic":
      return createAnthropic({ apiKey: cfg.apiKey })(cfg.modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey: cfg.apiKey })(cfg.modelId);
  }
}
