import { test } from "node:test";
import assert from "node:assert/strict";

import {
  findOptimizations,
  toConcerns,
  type MarketRates,
} from "../src/finance/optimizations.ts";
import type { FinancialProfile } from "../src/finance/profile.ts";

// A thin-income student profile — the target subject.
function studentProfile(
  over: Partial<FinancialProfile> = {},
): FinancialProfile {
  return {
    currency: "GBP",
    monthlyIncomeMinor: 120_000, // £1,200/mo
    monthlyEssentialSpendMinor: 90_000, // £900/mo
    liquidSavingsMinor: 500_000, // £5,000
    highCostDebtMinor: 0,
    incomeVolatility: "variable",
    supportNetwork: "some",
    hasRoleModel: false,
    entitlementsAware: false,
    hasUnclaimedSupport: false,
    hasFormalBanking: true,
    reliesOnInformalCredit: false,
    stage: "late-student",
    financialAnxiety: "moderate",
    ...over,
  };
}

// An "everything already optimal" market: no idle cash, no offers, allowances
// fully used, no flags.
function optimalMarket(over: Partial<MarketRates> = {}): MarketRates {
  return {
    inflationRate: 0.04,
    bestSavingsRate: 0.045,
    cashAccounts: [
      // earning above both inflation and the best rate → no win
      { id: "a1", provider: "TopBank", balanceMinor: 500_000, annualRate: 0.05 },
    ],
    switchOffers: [],
    isaAllowanceMinor: 2_000_000,
    isaUsedMinor: 2_000_000,
    lisaAllowanceMinor: 400_000,
    lisaUsedMinor: 400_000,
    lisaBonusRate: 0.25,
    riskFlags: [],
    ...over,
  };
}

test("idle cash below inflation flags with the right £/year real loss", () => {
  const profile = studentProfile();
  const market = optimalMarket({
    inflationRate: 0.04,
    bestSavingsRate: 0.04, // == inflation so the inflation find isn't also a switch find
    cashAccounts: [
      // £5,000 at 0% vs 4% inflation → £200/yr real-terms loss
      { id: "c", provider: "ZeroBank", balanceMinor: 500_000, annualRate: 0 },
    ],
  });

  const opts = findOptimizations(profile, market);
  const idle = opts.find((o) => o.id === "idle_cash_inflation");
  assert.ok(idle, "expected an idle_cash_inflation optimization");
  assert.equal(idle.valuePerYearMinor, 20_000); // £200
  assert.match(idle.action, /move idle cash out of ZeroBank/);
  // £200/yr < a quarter-month income (£1,200*0.25=£300) → low for this earner.
  assert.equal(idle.severity, "low");
});

test("a better rate elsewhere flags a switch with the gain", () => {
  const profile = studentProfile();
  const market = optimalMarket({
    inflationRate: 0.0, // disable the inflation find so we isolate the rate switch
    bestSavingsRate: 0.05,
    cashAccounts: [
      // £10,000 at 1% vs 5% best → £400/yr gain
      { id: "c", provider: "SlowBank", balanceMinor: 1_000_000, annualRate: 0.01 },
    ],
  });

  const opts = findOptimizations(profile, market);
  const switchRate = opts.find((o) => o.id === "missed_savings_rate");
  assert.ok(switchRate, "expected a missed_savings_rate optimization");
  assert.equal(switchRate.valuePerYearMinor, 40_000); // £400
  assert.match(switchRate.action, /move the £10000 from SlowBank/);
});

test("switch bonus surfaces as free money with the concrete action", () => {
  const profile = studentProfile();
  const market = optimalMarket({
    switchOffers: [
      { provider: "BonusBank", bonusMinor: 20_000, requirement: "2 direct debits" },
    ],
  });

  const opts = findOptimizations(profile, market);
  const bonus = opts.find((o) => o.id === "missed_switch_bonus");
  assert.ok(bonus, "expected a missed_switch_bonus optimization");
  assert.equal(bonus.valuePerYearMinor, 20_000); // £200
  assert.match(bonus.action, /switch to BonusBank \(2 direct debits\)/);
});

test("unused ISA and LISA allowance both flag", () => {
  const profile = studentProfile();
  const market = optimalMarket({
    isaUsedMinor: 0, // full £20k allowance unused
    lisaUsedMinor: 0, // full £4k allowance unused
    bestSavingsRate: 0.045,
    lisaBonusRate: 0.25,
  });

  const opts = findOptimizations(profile, market);
  const isa = opts.find((o) => o.id === "unused_isa_allowance");
  const lisa = opts.find((o) => o.id === "unused_lisa_allowance");
  assert.ok(isa, "expected an unused_isa_allowance optimization");
  assert.ok(lisa, "expected an unused_lisa_allowance optimization");

  // ISA: movable = min(£20k room, £5k savings) = £5k * 4.5% = £225/yr proxy.
  assert.equal(isa.valuePerYearMinor, 22_500);
  // LISA: fundable = min(£4k room, savings-£900 cushion=£4,100) = £4,000 * 25% = £1,000.
  assert.equal(lisa.valuePerYearMinor, 100_000);
  assert.match(lisa.action, /claim the 25% top-up/);
});

test("an already-optimized profile flags nothing", () => {
  const profile = studentProfile({ liquidSavingsMinor: 0 }); // no spare for ISA/LISA
  const opts = findOptimizations(profile, optimalMarket());
  assert.deepEqual(opts, []);
});

test("scam and FOMO guardrails fire flag-only on marked patterns", () => {
  const profile = studentProfile();
  const market = optimalMarket({
    riskFlags: [
      {
        kind: "scam_pattern",
        detail: "urgent transfer to a new crypto address",
        exposureMinor: 200_000,
      },
      {
        kind: "fomo_chasing",
        detail: "third top-up into a coin up 300% this week",
        exposureMinor: 200_000, // the −£2k FOMO loss (#16)
      },
    ],
  });

  const opts = findOptimizations(profile, market);
  const scam = opts.find((o) => o.id === "scam_pattern");
  const fomo = opts.find((o) => o.id === "fomo_chasing");
  assert.ok(scam, "expected a scam_pattern guardrail");
  assert.ok(fomo, "expected a fomo_chasing guardrail");
  assert.equal(scam.severity, "high");
  // Non-punitive: the action offers to help, never reprimands.
  assert.match(scam.action, /verify before any payment/);
  assert.match(fomo.action, /cooling-off check/);
});

test("results are sorted by £/year value descending", () => {
  const profile = studentProfile();
  const market = optimalMarket({
    isaUsedMinor: 0,
    lisaUsedMinor: 0,
    switchOffers: [
      { provider: "BonusBank", bonusMinor: 20_000, requirement: "2 DDs" },
    ],
    cashAccounts: [
      { id: "c", provider: "ZeroBank", balanceMinor: 500_000, annualRate: 0 },
    ],
  });

  const opts = findOptimizations(profile, market);
  assert.ok(opts.length > 1);
  for (let i = 1; i < opts.length; i++) {
    assert.ok(
      opts[i - 1].valuePerYearMinor >= opts[i].valuePerYearMinor,
      "expected descending order by valuePerYearMinor",
    );
  }
});

test("toConcerns maps onto the watch.ts Concern shape", () => {
  const profile = studentProfile();
  const market = optimalMarket({
    switchOffers: [
      { provider: "BonusBank", bonusMinor: 20_000, requirement: "2 DDs" },
    ],
  });

  const concerns = toConcerns(findOptimizations(profile, market));
  assert.ok(concerns.length >= 1);
  for (const c of concerns) {
    // Concern shape: kind, severity, reason, suggestion (all strings/enums).
    assert.equal(typeof c.kind, "string");
    assert.ok(["low", "medium", "high"].includes(c.severity));
    assert.equal(typeof c.reason, "string");
    assert.equal(typeof c.suggestion, "string");
  }
  const bonusConcern = concerns.find((c) => /BonusBank/.test(c.reason));
  assert.ok(bonusConcern);
  assert.match(bonusConcern.reason, /~£200\/yr/);
});
