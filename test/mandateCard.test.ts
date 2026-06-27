import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSpendCard, compareSpendCard, type SpendMandateCard } from "../src/core/mandateCard.ts";
import type { Mandate } from "../src/core/types.ts";

function sampleMandate(): Mandate {
  return {
    id: "m1",
    label: "Groceries Mandate",
    scope: { kind: "class", value: "groceries" },
    currency: "GBP",
    allowedRails: ["card"],
    perTxCap: 100_00,
    perPeriodCap: 500_00,
    period: "week",
    grantedAt: "2026-05-01T00:00:00Z",
    expiresAt: "2026-06-30T00:00:00Z",
    status: "active",
  };
}

test("generateSpendCard maps mandates to a Spend Mandate Card representation", () => {
  const m = sampleMandate();
  const card = generateSpendCard("test-agent", [m]);

  assert.equal(card.agentId, "test-agent");
  assert.equal(card.requiredMandates.length, 1);
  assert.equal(card.requiredMandates[0].class, "groceries");
  assert.equal(card.requiredMandates[0].currency, "GBP");
  assert.equal(card.requiredMandates[0].suggestedPerTxCap, 100_00);
});

test("compareSpendCard correctly identifies missing or insufficient mandates", () => {
  const m = sampleMandate();
  const card: SpendMandateCard = {
    agentId: "test-agent",
    requiredMandates: [
      {
        class: "groceries",
        currency: "GBP",
        suggestedPerTxCap: 100_00,
        suggestedPerPeriodCap: 500_00,
        period: "week",
        rails: ["card"],
      },
      {
        class: "saas",
        currency: "USD",
        suggestedPerTxCap: 50_00,
        suggestedPerPeriodCap: 100_00,
        period: "month",
        rails: ["card"],
      },
    ],
  };

  // Compare with only groceries mandate active
  const result1 = compareSpendCard(card, [m]);
  assert.equal(result1.covers, false);
  assert.equal(result1.missing.length, 1);
  assert.equal(result1.missing[0].class, "saas");

  // Compare after adding a matching saas mandate
  const saasMandate: Mandate = {
    id: "m2",
    label: "SaaS Mandate",
    scope: { kind: "class", value: "saas" },
    currency: "USD",
    allowedRails: ["card"],
    perTxCap: 60_00, // covers 50_00
    perPeriodCap: 200_00, // covers 100_00
    period: "month",
    grantedAt: "2026-05-01T00:00:00Z",
    expiresAt: "2026-06-30T00:00:00Z",
    status: "active",
  };

  const result2 = compareSpendCard(card, [m, saasMandate]);
  assert.equal(result2.covers, true);
  assert.equal(result2.missing.length, 0);
});
