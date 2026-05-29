// LLM-loop governance + per-run observability for the agent loop. Distinct from
// the gate (which governs MONEY): this governs the MODEL — bounding a runaway or
// looping agent before it burns tokens (the "denial of wallet" failure mode) and
// capturing a per-run trace for observability.

import type { StopCondition } from "ai";

export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
export const DEFAULT_MAX_STEPS = 6;
export const DEFAULT_REPEAT_THRESHOLD = 3;

/** Stop the loop when the last `threshold` tool calls are identical (same tool +
 * same input) — the doom-loop guard (LangChain's LoopDetection pattern). The gate
 * already blocks bad payments; this stops the agent uselessly re-proposing them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches the SDK's own stepCountIs: StopCondition<any>
export function repeatedToolCallStop(
  threshold: number = DEFAULT_REPEAT_THRESHOLD,
  // deno-lint-ignore no-explicit-any
): StopCondition<any> {
  return ({ steps }) => {
    const sigs = steps
      .flatMap((s) => s.toolCalls)
      .map((c) => `${c.toolName}:${JSON.stringify(c.input)}`);
    if (sigs.length < threshold) return false;
    const last = sigs.slice(-threshold);
    return last.every((s) => s === last[0]);
  };
}

export interface RunTrace {
  steps: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  finishReason: string;
}

/** Build a per-run observability trace from a generateText result. */
export function traceFrom(result: {
  steps: ReadonlyArray<unknown>;
  totalUsage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    totalTokens: number | undefined;
  };
  finishReason: string;
}): RunTrace {
  const inputTokens = result.totalUsage.inputTokens ?? 0;
  const outputTokens = result.totalUsage.outputTokens ?? 0;
  return {
    steps: result.steps.length,
    inputTokens,
    outputTokens,
    totalTokens: result.totalUsage.totalTokens ?? inputTokens + outputTokens,
    finishReason: result.finishReason,
  };
}
