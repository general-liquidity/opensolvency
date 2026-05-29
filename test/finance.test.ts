import { test } from "node:test";
import assert from "node:assert/strict";

import { assessResilience } from "../src/finance/resilience.ts";
import { detectMoment } from "../src/finance/moments.ts";
import { watchSpending, type SpendObservation } from "../src/finance/watch.ts";
import { planGoal, type FinancialGoal } from "../src/finance/goals.ts";
import type { FinancialProfile } from "../src/finance/profile.ts";

const NOW = "2026-05-30T12:00:00.000Z";

function profile(over: Partial<FinancialProfile> = {}): FinancialProfile {
  return {
    currency: "GBP",
    monthlyIncomeMinor: 2000_00,
    monthlyEssentialSpendMinor: 1000_00,
    liquidSavingsMinor: 3000_00, // ~3 months buffer
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

// --- moments (teachable + reachable) ---

test("income arriving is a moment the agent can act on even when away", () => {
  const p = profile();
  const m = detectMoment(
    { kind: "income_received", amountMinor: 1500_00 },
    { profile: p, resilience: assessResilience(p), operatorEngaged: false },
  );
  assert.ok(m);
  assert.equal(m.topic, "windfall_allocation");
  assert.equal(m.surface, true); // actionable when away → reachable
});

test("a high-cost-credit payment is held until the operator is reachable", () => {
  const p = profile();
  const r = assessResilience(p);
  const ev = {
    kind: "transaction" as const,
    amountMinor: 200_00,
    payeeClass: "misc",
    rail: "card" as const,
    highCostCredit: true,
  };
  const away = detectMoment(ev, { profile: p, resilience: r, operatorEngaged: false });
  assert.ok(away);
  assert.equal(away.topic, "high_cost_debt");
  assert.equal(away.teachable, true);
  assert.equal(away.surface, false); // teachable but not reachable

  const here = detectMoment(ev, { profile: p, resilience: r, operatorEngaged: true });
  assert.equal(here?.surface, true);
});

test("idle sweep surfaces unclaimed support when policy is the weak pillar", () => {
  const p = profile({
    entitlementsAware: false,
    hasUnclaimedSupport: true,
    supportNetwork: "strong",
    hasRoleModel: true,
  });
  const r = assessResilience(p);
  assert.equal(r.weakestPillar, "policy");
  const m = detectMoment(
    { kind: "idle_check" },
    { profile: p, resilience: r, operatorEngaged: true },
  );
  assert.equal(m?.topic, "unclaimed_support");
});

test("an idle sweep on a healthy profile yields no moment", () => {
  const p = profile({
    monthlyIncomeMinor: 3000_00,
    liquidSavingsMinor: 9000_00,
    supportNetwork: "strong",
    hasRoleModel: true,
  });
  const m = detectMoment(
    { kind: "idle_check" },
    { profile: p, resilience: assessResilience(p), operatorEngaged: true },
  );
  assert.equal(m, null);
});

// --- watch ("watching your back" → concerns) ---

test("watchSpending flags repeated high-cost-credit use", () => {
  const recent: SpendObservation[] = [
    { amountMinor: 50_00, payeeClass: "misc", rail: "card", highCostCredit: true, at: NOW },
    { amountMinor: 50_00, payeeClass: "misc", rail: "card", highCostCredit: true, at: NOW },
  ];
  const concerns = watchSpending(recent, profile());
  const c = concerns.find((x) => x.kind === "high_cost_credit_reliance");
  assert.ok(c);
  assert.equal(c.severity, "medium");
  // non-punitive: framed as an agent offer, not a reprimand
  assert.match(c.suggestion, /^(offer|propose)/);
});

test("watchSpending flags spending over a month's income", () => {
  const concerns = watchSpending(
    [{ amountMinor: 130_00, payeeClass: "misc", rail: "card", at: NOW }],
    profile({ monthlyIncomeMinor: 100_00 }),
  );
  assert.ok(concerns.some((x) => x.kind === "essential_overspend"));
});

// --- goals (anchoring → agent objectives) ---

test("planGoal computes a feasible monthly contribution", () => {
  const p = profile({ monthlyIncomeMinor: 2000_00, monthlyEssentialSpendMinor: 1000_00 });
  const goal: FinancialGoal = {
    id: "g1",
    label: "emergency fund",
    currency: "GBP",
    targetMinor: 6000_00,
    currentMinor: 0,
    deadline: "2026-11-30T00:00:00.000Z",
  };
  const plan = planGoal(goal, p, NOW);
  assert.equal(plan.remainingMinor, 6000_00);
  assert.ok(plan.requiredMonthlyMinor !== null && plan.requiredMonthlyMinor <= 1000_00);
  assert.equal(plan.feasible, true);
});

test("planGoal flags a goal that outruns the surplus", () => {
  const p = profile({ monthlyIncomeMinor: 1100_00, monthlyEssentialSpendMinor: 1000_00 });
  const plan = planGoal(
    {
      id: "g2",
      label: "deposit",
      currency: "GBP",
      targetMinor: 6000_00,
      currentMinor: 0,
      deadline: "2026-08-30T00:00:00.000Z",
    },
    p,
    NOW,
  );
  assert.equal(plan.feasible, false);
});

test("planGoal recognises a goal already reached", () => {
  const plan = planGoal(
    { id: "g3", label: "done", currency: "GBP", targetMinor: 100, currentMinor: 100 },
    profile(),
    NOW,
  );
  assert.equal(plan.remainingMinor, 0);
  assert.equal(plan.feasible, true);
});
