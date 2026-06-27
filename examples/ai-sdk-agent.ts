#!/usr/bin/env node
// Reference example: a real Vercel AI SDK agent whose spend is gated in one line.
// Needs a model key (AGENTWORTH_MODEL_API_KEY). The model's `pay` tool executes
// THROUGH the gate — the autonomous loop cannot bypass it.

import { generateText, stepCountIs } from "ai";
import { AgentWorth } from "../src/sdk/index.ts";
import { createGatedPayTool } from "../src/integrations/index.ts";
import { createAiModel, isModelProvider, PROVIDER_API_KEY_ENV, DEFAULT_MODEL_ID } from "../src/agent/aiSdkModel.ts";

async function main(): Promise<void> {
  const raw = process.env.AGENTWORTH_MODEL_PROVIDER ?? "openai";
  const provider = isModelProvider(raw) ? raw : "openai";
  const apiKey = process.env.AGENTWORTH_MODEL_API_KEY ?? process.env[PROVIDER_API_KEY_ENV[provider]];
  if (!apiKey) {
    console.error("set AGENTWORTH_MODEL_API_KEY (and optionally AGENTWORTH_MODEL_PROVIDER).");
    process.exit(1);
  }
  const cfg = { provider, modelId: process.env.AGENTWORTH_MODEL ?? DEFAULT_MODEL_ID[provider], apiKey };

  const os = new AgentWorth();
  os.grantMandate({
    label: "groceries", scope: { kind: "class", value: "groceries" }, currency: "GBP",
    allowedRails: ["card"], perTxCap: 500_00, perPeriodCap: 1000_00, period: "week", expiresInDays: 30,
  });

  const result = await generateText({
    model: createAiModel(cfg),
    stopWhen: stepCountIs(4),
    tools: { pay: createGatedPayTool({ executor: os.executor }) },
    prompt:
      "You are a shopping agent. Pay 'tesco' £80 (8000 minor-units, GBP, rail 'card') " +
      "for the weekly grocery shop, then report the outcome. payeeClass is 'groceries'.",
  });

  console.log(result.text);
  for (const p of os.pending()) console.log(`pending: ${p.intent.payee} ${p.intent.amount} — approve to settle`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
