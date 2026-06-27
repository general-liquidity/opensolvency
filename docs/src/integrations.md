# Gate any framework's spend

Drop the gate into any agent framework in one line. The native **Vercel AI SDK**
binding:

```ts
import { generateText } from "ai";
import { createGatedPayTool } from "@general-liquidity/agentworth/integrations";

await generateText({
  model, prompt,
  tools: { pay: createGatedPayTool({ executor }) },   // the model's spend is now gated
});
```

Every other framework wraps the same framework-agnostic `gatedPay(deps, draft)`
handler with the shared schema:

```ts
import { gatedPay, gatedPayInputSchema, GATED_PAY_DESCRIPTION }
  from "@general-liquidity/agentworth/integrations";

// Mastra
createTool({ id: "pay", description: GATED_PAY_DESCRIPTION, inputSchema: gatedPayInputSchema,
  execute: ({ context }) => gatedPay({ executor }, context) });

// LangChain / OpenAI Agents / CrewAI: register a tool whose handler is
//   (draft) => gatedPay({ executor }, draft)
```

The handler routes through `executor.execute`, so the gate governs every call no
matter which framework calls it — auto-execute inside a mandate, park for approval,
or block. No prompt can override it.

## In CI

A GitHub Action gates spend inside pipelines (an agent buying compute/credits):

```yaml
- uses: general-liquidity/agentworth@v0.1.0
  with: { payee: vast-ai, payee-class: compute, amount: "5000", rationale: "GPU hours" }
  env: { AGENTWORTH_DB: ${{ github.workspace }}/agentworth.db }
```
