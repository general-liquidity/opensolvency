// Framework integration adapters — gate any agent framework's spend in one line.
// The framework-agnostic core (`gatedPay` + name/description/schema) plus the
// native Vercel AI SDK binding. Other frameworks (Mastra, LangChain, OpenAI
// Agents, CrewAI) wrap `gatedPay` with the shared schema — see the README.

export {
  gatedPay,
  gatedPayInputSchema,
  GATED_PAY_NAME,
  GATED_PAY_DESCRIPTION,
  type GatedPayDeps,
  type GatedPayResult,
} from "./gatedPay.ts";
export { createGatedPayTool } from "./aiSdk.ts";
