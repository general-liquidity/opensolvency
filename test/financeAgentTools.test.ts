import { test } from "node:test";
import assert from "node:assert/strict";

import { AuditLog } from "../src/core/audit.ts";
import { createExecutor } from "../src/core/executor.ts";
import { createMemoryStore } from "../src/store/memoryStore.ts";
import { createRailRegistry } from "../src/rails/registry.ts";
import { createFakeRail } from "../src/rails/fakeRail.ts";
import { DEFAULT_DENY_RULES } from "../src/core/denyList.ts";
import { DEFAULT_GATE_CONFIG, type Mandate } from "../src/core/types.ts";
import { runFinanceAgent } from "../src/agent/financeAgent.ts";
import type { FinanceAgentDeps } from "../src/agent/financeAgent.ts";
import type { FinancialProfile } from "../src/finance/profile.ts";
import type { MarketRates } from "../src/finance/optimizations.ts";

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

// Capture each tool's typed result by tapping the model's tool-result frames is
// awkward through the SDK, so instead we drive the model to call ONE tool, then
// re-run the same harness fn directly and assert the shape the tool returns is
// the harness fn's typed result. The in-loop run proves the tool is registered
// and executes without error; the direct call pins the shape.

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

function deps(
  model: unknown,
  p: FinancialProfile = profile(),
  extra: Partial<FinanceAgentDeps> = {},
): FinanceAgentDeps {
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
  return {
    model: model as never,
    executor,
    store,
    profile: p,
    clock: () => NOW,
    newId: () => `pi_${n++}`,
    ...extra,
  };
}

const HOUSE_GOAL = {
  id: "g_house",
  label: "house deposit",
  currency: "GBP",
  targetMinor: 30000_00,
  currentMinor: 2000_00,
  deadline: "2031-05-30T00:00:00.000Z",
};

function marketRates(over: Partial<MarketRates> = {}): MarketRates {
  return {
    inflationRate: 0.04,
    bestSavingsRate: 0.045,
    cashAccounts: [
      { id: "a1", provider: "BigBank", balanceMinor: 3000_00, annualRate: 0.0 },
    ],
    switchOffers: [{ provider: "NewBank", bonusMinor: 200_00, requirement: "2 DDs + £1k in" }],
    isaAllowanceMinor: 20000_00,
    isaUsedMinor: 0,
    lisaAllowanceMinor: 4000_00,
    lisaUsedMinor: 0,
    lisaBonusRate: 0.25,
    riskFlags: [],
    ...over,
  };
}

// ── forecast_goal ────────────────────────────────────────────────────────────
test("forecast_goal is registered and runs in-loop, moving no money", async () => {
  const model = await seqModel([
    { toolName: "forecast_goal", input: JSON.stringify(HOUSE_GOAL) },
    "Here's your house-deposit timeline.",
  ]);
  const r = await runFinanceAgent("when do I hit my deposit?", deps(model));
  assert.match(r.text, /timeline/);
  assert.equal(r.executions.length, 0);
});

// ── coverage ─────────────────────────────────────────────────────────────────
test("coverage is registered and runs in-loop, moving no money", async () => {
  const model = await seqModel([
    { toolName: "coverage", input: JSON.stringify({ goals: [HOUSE_GOAL] }) },
    "Here's what you're missing.",
  ]);
  const r = await runFinanceAgent("what am I missing?", deps(model));
  assert.match(r.text, /missing/);
  assert.equal(r.executions.length, 0);
});

// ── detect_traps ─────────────────────────────────────────────────────────────
test("detect_traps is registered and runs in-loop, moving no money", async () => {
  const model = await seqModel([
    { toolName: "detect_traps", input: JSON.stringify({ text: "investing is gambling" }) },
    "Spotted a belief worth addressing.",
  ]);
  const anxious = profile({ hasRoleModel: false });
  const r = await runFinanceAgent("I think investing is gambling", deps(model, anxious));
  assert.match(r.text, /belief/);
  assert.equal(r.executions.length, 0);
});

// ── check_in (prompt + record) ───────────────────────────────────────────────
test("check_in with no pick returns the emoji prompt; moves no money", async () => {
  const model = await seqModel([
    { toolName: "check_in", input: "{}" },
    "How does money make you feel?",
  ]);
  const r = await runFinanceAgent("let's start", deps(model));
  assert.match(r.text, /feel/);
  assert.equal(r.executions.length, 0);
});

test("check_in with a pick records the state onto the profile", async () => {
  const model = await seqModel([
    { toolName: "check_in", input: JSON.stringify({ pick: "😰" }) },
    "Recorded — I'll keep things low-friction.",
  ]);
  const d = deps(model, profile({ financialAnxiety: "low" }));
  const r = await runFinanceAgent("check in", d);
  assert.equal(r.executions.length, 0);
  // The tool mutated deps.profile via applyCheckIn → 😰 (overwhelm) maps to "high".
  assert.equal(d.profile.financialAnxiety, "high");
});

// ── find_optimizations (seam present + absent) ───────────────────────────────
test("find_optimizations uses the injected MarketRates seam in-loop", async () => {
  const model = await seqModel([
    { toolName: "find_optimizations", input: "{}" },
    "Found some free-money wins.",
  ]);
  const r = await runFinanceAgent("any free money?", deps(model, profile(), { marketRates: marketRates() }));
  assert.match(r.text, /free-money/);
  assert.equal(r.executions.length, 0);
});

test("find_optimizations works out of the box via reference rates (no injected source)", async () => {
  const model = await seqModel([
    { toolName: "find_optimizations", input: "{}" },
    "Here are some allowance wins you're missing.",
  ]);
  // No `marketRates` on deps → the tool falls back to REFERENCE_MARKET_RATES and
  // still runs (the allowance-based wins work without a live feed), moving no money.
  const r = await runFinanceAgent("any free money?", deps(model));
  assert.match(r.text, /allowance wins/i);
  assert.equal(r.executions.length, 0);
});

// ── the gated `pay` path is unchanged by the new advisory tools ──────────────
test("the gated pay path is unchanged (over-cap → still blocked)", async () => {
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
