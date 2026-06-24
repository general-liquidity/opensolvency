// Vercel AI SDK adapter — the native binding. Drop the returned tool into any AI
// SDK agent's `tools` and its spend is gated:
//
//   import { generateText } from "ai";
//   import { createGatedPayTool } from "@general-liquidity/opensolvency/integrations";
//
//   await generateText({
//     model, prompt,
//     tools: { pay: createGatedPayTool({ executor }) },
//   });
//
// The model's `pay` calls execute THROUGH the gate — the autonomous loop can't
// bypass it. This is the same gate-enforced tool OpenSolvency uses internally,
// exposed for external AI SDK agents.

import { tool } from "ai";
import { gatedPay, gatedPayInputSchema, GATED_PAY_DESCRIPTION, type GatedPayDeps } from "./gatedPay.ts";

export function createGatedPayTool(deps: GatedPayDeps) {
  return tool({
    description: GATED_PAY_DESCRIPTION,
    inputSchema: gatedPayInputSchema,
    execute: async (draft) => gatedPay(deps, draft),
  });
}
