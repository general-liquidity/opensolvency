import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ListScreener,
  denyRuleFromCompliance,
  reputationFromCompliance,
  type ComplianceProvider,
  type ComplianceVerdict,
  type SanctionEntry,
} from "../src/compliance/sanctions.ts";
import { makeStructuringScreener } from "../src/compliance/aml.ts";
import { evaluateGate } from "../src/core/gate.ts";
import { DEFAULT_DENY_RULES } from "../src/core/denyList.ts";
import {
  DEFAULT_GATE_CONFIG,
  RAIL_REVERSIBILITY,
  type GateContext,
  type Mandate,
  type PaymentIntent,
  type PriorSpend,
} from "../src/core/types.ts";

const NOW = "2026-05-29T12:00:00.000Z";

const SDN_LIST: SanctionEntry[] = [
  {
    ref: "OFAC-SDN-12345",
    name: "ACME Laundering LLC",
    aliases: ["acme-launder"],
    payees: ["acme-launder-llc"],
    chainAddresses: ["0xBAD0BAD0BAD0BAD0BAD0BAD0BAD0BAD0BAD0BAD0"],
  },
];

function mandate(over: Partial<Mandate> = {}): Mandate {
  return {
    id: "m_groceries",
    label: "weekly groceries",
    scope: { kind: "class", value: "groceries" },
    currency: "GBP",
    allowedRails: ["card"],
    perTxCap: 500_00,
    perPeriodCap: 1_000_00,
    period: "week",
    grantedAt: "2026-05-26T00:00:00.000Z",
    expiresAt: "2026-06-26T00:00:00.000Z",
    status: "active",
    ...over,
  };
}

function intent(over: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: "pi_1",
    payee: "tesco",
    payeeClass: "groceries",
    amount: 80_00,
    currency: "GBP",
    rail: "card",
    rationale: "weekly grocery shop",
    createdAt: NOW,
    ...over,
  };
}

function ctx(
  over: Partial<GateContext> = {},
  periodSpend: PriorSpend[] = [],
): GateContext {
  return {
    now: NOW,
    mandates: [mandate()],
    periodSpendByMandate: () => periodSpend,
    knownPayees: new Set(["tesco", "acme-launder-llc"]),
    denyRules: DEFAULT_DENY_RULES,
    config: DEFAULT_GATE_CONFIG,
    ...over,
  };
}

// --- ListScreener verdicts -------------------------------------------------

test("a payee on the sanctions list → blocked with a reason naming the listing", () => {
  const screener = new ListScreener({ list: SDN_LIST });
  const v = screener.screen(
    intent({ payee: "acme-launder-llc" }),
    { knownPayees: new Set(), reversibility: "reversible" },
  );
  assert.equal(v.status, "blocked");
  if (v.status === "blocked") assert.match(v.reason, /OFAC-SDN-12345/);
});

test("matches on name/alias and chain address too", () => {
  const screener = new ListScreener({ list: SDN_LIST });
  for (const payee of [
    "ACME Laundering LLC", // name (case/space-normalized)
    "acme-launder", // alias
    "0xbad0bad0bad0bad0bad0bad0bad0bad0bad0bad0", // chain address (lowercased)
  ]) {
    const v = screener.screen(intent({ payee }), {
      knownPayees: new Set(),
      reversibility: "irreversible",
    });
    assert.equal(v.status, "blocked", `${payee} should be blocked`);
  }
});

test("a clean payee → clear", () => {
  const screener = new ListScreener({ list: SDN_LIST });
  const v = screener.screen(intent({ payee: "tesco" }), {
    knownPayees: new Set(["tesco"]),
    reversibility: "reversible",
  });
  assert.equal(v.status, "clear");
});

// --- denyRuleFromCompliance integrates with the EXISTING gate --------------

test("denyRuleFromCompliance blocks a sanctioned intent through the real gate", () => {
  const screener = new ListScreener({ list: SDN_LIST });
  const denyRules = [...DEFAULT_DENY_RULES, denyRuleFromCompliance(screener)];

  // acme is a KNOWN, in-class, under-cap payee — without compliance it would
  // auto-execute. The screener must override that to a hard block.
  const d = evaluateGate(
    intent({ payee: "acme-launder-llc", amount: 80_00 }),
    ctx({ denyRules }),
  );
  assert.equal(d.outcome, "block");
  assert.ok(d.reasons.some((r) => r.includes("deny-list")));
  assert.ok(d.reasons.some((r) => r.includes("compliance")));

  // the per-listing ref (OFAC id) lives on the screener verdict — the gate's
  // boolean DenyRule.match only carries the static rule reason, so callers that
  // want the listing detail screen() directly (e.g. for the audit log).
  const v = screener.screen(intent({ payee: "acme-launder-llc" }), {
    knownPayees: ctx({ denyRules }).knownPayees,
    reversibility: "reversible",
  });
  assert.equal(v.status, "blocked");
  if (v.status === "blocked") assert.match(v.reason, /OFAC-SDN-12345/);
});

test("denyRuleFromCompliance leaves a clean payee unaffected", () => {
  const screener = new ListScreener({ list: SDN_LIST });
  const denyRules = [...DEFAULT_DENY_RULES, denyRuleFromCompliance(screener)];
  const d = evaluateGate(intent({ payee: "tesco" }), ctx({ denyRules }));
  assert.equal(d.outcome, "auto_execute");
});

test("compliance only ADDS denials — it never relaxes the gate floor", () => {
  // An empty list clears everyone, but the gate's own caps still bind: an
  // over-cap payment to a clean payee is still blocked.
  const screener = new ListScreener({ list: [] });
  const denyRules = [...DEFAULT_DENY_RULES, denyRuleFromCompliance(screener)];
  const d = evaluateGate(
    intent({ payee: "tesco", amount: 600_00 }),
    ctx({ denyRules }),
  );
  assert.equal(d.outcome, "block");
  assert.ok(d.reasons.some((r) => r.includes("per-transaction cap")));
});

// --- reputationFromCompliance: flagged → risk bump via the existing seam ---

test("reputationFromCompliance maps a flagged payee to 'flagged' for the risk classifier", () => {
  const flagger: ComplianceProvider = {
    id: "flagger",
    screen: (i: PaymentIntent): ComplianceVerdict =>
      i.payee === "shady"
        ? { status: "flagged", riskBump: 2, reasons: ["watchlist"] }
        : { status: "clear" },
  };
  const reputationOf = reputationFromCompliance(flagger, {
    knownPayees: new Set(["shady"]),
    reversibilityOf: (i) => RAIL_REVERSIBILITY[i.rail],
  });
  assert.equal(reputationOf(intent({ payee: "shady" })), "flagged");
  assert.equal(reputationOf(intent({ payee: "tesco" })), undefined);

  // and it surfaces in the gate's risk reasons (flagged payee → risk bump)
  const d = evaluateGate(
    intent({ payee: "shady", payeeClass: "groceries" }),
    ctx({
      knownPayees: new Set(["shady"]),
      reputationOf: (p) => reputationOf(intent({ payee: p })),
    }),
  );
  assert.ok(
    d.risk.reasons.some((r) => r.includes("flagged in network reputation")),
  );
});

// --- AML structuring heuristic (optional) ----------------------------------

test("structuring screener flags a cluster of just-under-threshold payments", () => {
  const priors: PriorSpend[] = [
    { amount: 9_500_00, at: "2026-05-29T09:00:00.000Z" },
    { amount: 9_400_00, at: "2026-05-29T10:00:00.000Z" },
  ];
  const screener = makeStructuringScreener(
    { thresholdMinor: 10_000_00, marginFraction: 0.1, minCount: 3 },
    { now: NOW, recentPayments: () => priors },
  );
  const v = screener.screen(intent({ amount: 9_300_00 }));
  assert.equal(v.status, "flagged");

  // a single normal-sized payment is clear
  const clean = makeStructuringScreener(
    { thresholdMinor: 10_000_00 },
    { now: NOW, recentPayments: () => [] },
  );
  assert.equal(clean.screen(intent({ amount: 80_00 })).status, "clear");
});
