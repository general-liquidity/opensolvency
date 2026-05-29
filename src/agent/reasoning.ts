// Reasoning sandwich — phase-differentiated reasoning effort across the agent's
// step loop (the LangChain result: plan + verify benefit most from high effort,
// the middle from less). Implemented as a `prepareStep` that sets per-step
// providerOptions. The effort knobs are provider-specific (OpenAI reasoningEffort
// shown); providers that don't support them ignore the option. The live tuning
// effect isn't observable in a mock, but the phase→effort mapping is pure + tested.

export type ReasoningEffort = "low" | "medium" | "high";

/** Plan (step 0) and the tail steps get high effort; the build middle gets less. */
export function reasoningForStep(stepNumber: number, maxSteps: number): ReasoningEffort {
  if (stepNumber === 0) return "high"; // planning
  if (stepNumber >= maxSteps - 1) return "high"; // verification tail
  return "medium"; // build
}

export function reasoningSandwich(maxSteps: number) {
  return (opts: { stepNumber: number }) => ({
    providerOptions: {
      openai: { reasoningEffort: reasoningForStep(opts.stepNumber, maxSteps) },
    },
  });
}
