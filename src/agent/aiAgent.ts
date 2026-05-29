// The real agent runtime, on the Vercel AI SDK's multi-step tool loop.
//
// THE INVARIANT HOLDS THROUGH THE SDK: the model's only tool is `pay`, and that
// tool's `execute` runs the payment through `executor.execute` — i.e. through
// the gate. The SDK can loop autonomously (propose → settle/block → observe →
// propose again), but there is still no path to a rail that skips the gate.
// The gate's decision is handed back to the model as the tool result, so the
// agent reacts to a block/approval instead of blindly retrying.

import { generateText, stepCountIs, tool, type LanguageModel } from "ai";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_STEPS,
  repeatedToolCallStop,
  traceFrom,
  type RunTrace,
} from "./governance.ts";
import { PaymentIntentDraftSchema, type PaymentIntentDraft } from "./schema.ts";
import type { Executor, ExecuteResult } from "../core/executor.ts";
import type { Store } from "../core/store.ts";
import type { PaymentIntent } from "../core/types.ts";

export interface AiAgentDeps {
  model: LanguageModel;
  executor: Executor;
  store: Store;
  clock: () => string;
  newId: () => string;
  maxSteps?: number;
}

export interface AiAgentResult {
  text: string;
  executions: ExecuteResult[];
  trace: RunTrace;
}

/** The gate-enforced handler the `pay` tool wraps. The ONLY way the agent moves
 * money; it always routes through the executor (and therefore the gate). Kept
 * as a plain function so it is unit-testable without a model. */
export function runPaymentToolCall(
  draft: PaymentIntentDraft,
  deps: { executor: Executor; clock: () => string; newId: () => string },
): Promise<ExecuteResult> {
  const intent: PaymentIntent = {
    ...draft,
    id: deps.newId(),
    createdAt: deps.clock(),
  };
  return deps.executor.execute(intent);
}

function systemPrompt(store: Store, now: string): string {
  const mandates = store
    .listActiveMandates(now)
    .map(
      (m) =>
        `- ${m.label} [${m.id}]: ${JSON.stringify(m.scope)} ${m.currency} via ` +
        `${m.allowedRails.join("/")}, per-tx ${m.perTxCap}, ` +
        `per-${m.period} ${m.perPeriodCap} (minor-units)`,
    )
    .join("\n");
  return (
    "You are a spending agent. Use the `pay` tool to make payments that fit the " +
    "operator's standing mandates below. Every payment passes through a " +
    "governance gate you cannot override. If the tool result says a payment was " +
    "blocked or needs operator approval, do NOT retry it — report it instead. " +
    "Amounts are integer minor-units (800 = £8.00).\n\nMandates:\n" +
    (mandates || "(none granted)")
  );
}

/** The gate-enforced `pay` tool, shared by every agent runner so there is ONE
 * definition of the only money-moving path. Pushes each execution into `sink`. */
export function createPayTool(
  deps: { executor: Executor; clock: () => string; newId: () => string },
  sink: ExecuteResult[],
) {
  return tool({
    description:
      "Make a payment. It is routed through the governance gate and may be " +
      "auto-executed, parked for operator approval, or blocked.",
    inputSchema: PaymentIntentDraftSchema,
    execute: async (draft) => {
      const result = await runPaymentToolCall(draft, deps);
      sink.push(result);
      return {
        status: result.status,
        reasons: result.decision.reasons,
        receiptId: result.receipt?.id ?? null,
      };
    },
  });
}

export async function runAiAgent(
  goal: string,
  deps: AiAgentDeps,
): Promise<AiAgentResult> {
  const executions: ExecuteResult[] = [];
  const result = await generateText({
    model: deps.model,
    system: systemPrompt(deps.store, deps.clock()),
    prompt: goal,
    tools: { pay: createPayTool(deps, executions) },
    // A spending agent should propose deterministically, not creatively.
    temperature: 0,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    // Bound by step count AND by doom-loop detection (identical repeated calls).
    stopWhen: [stepCountIs(deps.maxSteps ?? DEFAULT_MAX_STEPS), repeatedToolCallStop()],
  });

  return { text: result.text, executions, trace: traceFrom(result) };
}
