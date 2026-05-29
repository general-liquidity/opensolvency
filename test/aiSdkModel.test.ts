import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createAiModel,
  isModelProvider,
  MODEL_PROVIDERS,
  DEFAULT_MODEL_ID,
} from "../src/agent/aiSdkModel.ts";

// Every provider wires through the AI SDK and produces a LanguageModel (no
// network — model construction is offline). Proves all provider packages are
// installed and the switch covers each.
test("creates a model for every supported provider", () => {
  for (const provider of MODEL_PROVIDERS) {
    const model = createAiModel({ provider, modelId: "test-model", apiKey: "k" });
    assert.ok(model, `expected a model for ${provider}`);
    // createAiModel always returns a model object, not the string shorthand.
    assert.ok(typeof model !== "string", "expected a LanguageModel object");
    assert.equal(typeof model.provider, "string");
    assert.equal(model.modelId, "test-model");
  }
});

test("isModelProvider guards unknown providers", () => {
  assert.equal(isModelProvider("openai"), true);
  assert.equal(isModelProvider("anthropic"), true);
  assert.equal(isModelProvider("google"), true);
  assert.equal(isModelProvider("llama-on-my-toaster"), false);
});

test("every provider has a default model id", () => {
  for (const provider of MODEL_PROVIDERS) {
    assert.equal(typeof DEFAULT_MODEL_ID[provider], "string");
    assert.ok(DEFAULT_MODEL_ID[provider].length > 0);
  }
});
