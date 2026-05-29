import { test } from "node:test";
import assert from "node:assert/strict";

import { AuditLog } from "../src/core/audit.ts";
import { createExecutor } from "../src/core/executor.ts";
import { createMemoryStore } from "../src/store/memoryStore.ts";
import { createRailRegistry } from "../src/rails/registry.ts";
import { createFakeRail } from "../src/rails/fakeRail.ts";
import { DEFAULT_DENY_RULES } from "../src/core/denyList.ts";
import { DEFAULT_GATE_CONFIG, type Mandate } from "../src/core/types.ts";
import { runFinanceAgent, runProactiveMoment } from "../src/agent/financeAgent.ts";
import type { FinancialProfile } from "../src/finance/profile.ts";

const NOW = "2026-05-30T12:00:00.000Z";

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

type Step = string | { toolName: string; input: string };

async function seqModel(steps: Step[]) {
  const { MockLanguageModelV3 } = await import("ai/test");
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      if (typeof step === "string") {
        return {
          content: [{ type: "text" as const, text: step }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: USAGE,
          warnings: [],
        };
      }
      return {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: `c${i}`,
            toolName: step.toolName,
            input: step.input,
          },
        ],
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage: USAGE,
        warnings: [],
      };
    },
  });
}

function profile(over: Partial<FinancialProfile> = {}): FinancialProfile {
  return {
    currency: "GBP",
    monthlyIncomeMinor: 2000_00,
    monthlyEssentialSpendMinor: 1000_00,
    liquidSavingsMinor: 3000_00,
    highCostDebtMinor: 0,
    incomeVolatility: "stable",
    supportNetwork: "some",
    hasRoleModel: false,
    entitlementsAware: true,
    hasUnclaimedSupport: false,
    hasFormalBanking: true,
    reliesOnInformalCredit: false,
    stage: "late-student",
    financialAnxiety: "low",
    ...over,
  };
}

function deps(model: unknown, p: FinancialProfile = profile()) {
  const store = createMemoryStore("k");
  store.insertMandate({
    id: "m_groceries",
    label: "groceries",
    scope: { kind: "class", value: "groceries" },
    currency: "GBP",
    allowedRails: ["card"],
    perTxCap: 500_00,
    perPeriodCap: 1000_00,
    period: "week",
    grantedAt: "2026-05-26T00:00:00.000Z",
    expiresAt: "2026-06-26T00:00:00.000Z",
    status: "active",
  } satisfies Mandate);
  const executor = createExecutor({
    store,
    rails: createRailRegistry([createFakeRail("card")]),
    audit: new AuditLog(store.operatorKey()),
    config: DEFAULT_GATE_CONFIG,
    denyRules: DEFAULT_DENY_RULES,
    clock: () => NOW,
  });
  let n = 0;
  // model is a MockLanguageModelV3, structurally a LanguageModel for the SDK.
  return {
    model: model as never,
    executor,
    store,
    profile: p,
    clock: () => NOW,
    newId: () => `pi_${n++}`,
  };
}

// The PF agent is helpful AND still gated: an over-cap pay it proposes is blocked.
test("the finance agent still cannot bypass the gate (over-cap → blocked)", async () => {
  const model = await seqModel([
    {
      toolName: "pay",
      input: JSON.stringify({
        payee: "tesco",
        payeeClass: "groceries",
        amount: 600_00,
        currency: "GBP",
        rail: "card",
        rationale: "buy the whole store",
      }),
    },
    "That payment was blocked by the gate.",
  ]);
  const r = await runFinanceAgent("buy everything", deps(model));
  assert.equal(r.executions.length, 1);
  assert.equal(r.executions[0].status, "blocked");
});

// The harness read-tools are wired and execute inside the loop without error.
test("the agent can call a harness tool (assess_resilience) in-loop", async () => {
  const model = await seqModel([
    { toolName: "assess_resilience", input: "{}" },
    "Your weakest pillar is social — let's strengthen it.",
  ]);
  const r = await runFinanceAgent("how am I doing?", deps(model));
  assert.match(r.text, /weakest/);
  assert.equal(r.executions.length, 0); // advisory tool moved no money
});

// Proactive: income arriving is a surfaced moment → the agent runs on it.
test("a surfaced moment runs the agent proactively", async () => {
  const model = await seqModel(["I've drafted an allocation toward your buffer."]);
  const out = await runProactiveMoment(
    { kind: "income_received", amountMinor: 1500_00 },
    { ...deps(model), operatorEngaged: false },
  );
  assert.equal(out.surfaced, true);
  assert.ok(out.result);
});

// LLM loop governance: identical repeated tool calls trip the doom-loop guard
// well before the step cap, so a flailing agent can't burn the budget.
test("the agent loop stops on repeated identical tool calls", async () => {
  const model = await seqModel([
    {
      toolName: "pay",
      input: JSON.stringify({
        payee: "tesco",
        payeeClass: "groceries",
        amount: 600_00,
        currency: "GBP",
        rail: "card",
        rationale: "again and again and again",
      }),
    },
  ]); // seqModel repeats the last step → the same over-cap pay call every step
  const r = await runFinanceAgent("keep trying", { ...deps(model), maxSteps: 10 });
  assert.ok(r.executions.length >= 3 && r.executions.length < 10); // stopped early
  assert.ok(r.executions.every((e) => e.status === "blocked"));
});

// A non-moment (healthy idle sweep) does not wake the agent.
test("a non-surfacing event does not run the agent", async () => {
  const model = await seqModel(["(should not be called)"]);
  const healthy = profile({
    monthlyIncomeMinor: 3000_00,
    liquidSavingsMinor: 9000_00,
    supportNetwork: "strong",
    hasRoleModel: true,
  });
  const out = await runProactiveMoment(
    { kind: "idle_check" },
    { ...deps(model, healthy), operatorEngaged: true },
  );
  assert.equal(out.surfaced, false);
  assert.equal(out.result, null);
});
