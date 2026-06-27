// Coverage / provenance guard — the analogue of Gordon's prompt-drift guard. These
// tests FAIL when the gate / deny-list / spec sources drift away from the generated
// scenario set, so a change to an authoritative spec can't ship without a scenario.

import test from "node:test";
import assert from "node:assert/strict";

import {
  generateScenarios,
  executionScenarios,
  advisoryScenarios,
  scenariosByProvenance,
  runEvalSuite,
  DENY_EXEMPLARS,
  SCENARIO_SOURCES,
  RUBRICS,
  stubJudge,
  llmJudge,
  type ScenarioSource,
} from "../src/evals/index.ts";
import { DEFAULT_DENY_RULES } from "../src/core/denyList.ts";

// ── deny-list coverage: every LIVE hard rule has a derived must-block scenario ──
test("every DEFAULT_DENY_RULES rule has an exemplar and a derived scenario", () => {
  for (const rule of DEFAULT_DENY_RULES) {
    assert.ok(
      DENY_EXEMPLARS[rule.id],
      `deny rule "${rule.id}" has no exemplar in DENY_EXEMPLARS — add one so it gets a regression scenario`,
    );
    assert.equal(
      scenariosByProvenance(`denylist:${rule.id}`).length,
      1,
      `deny rule "${rule.id}" produced no derived scenario`,
    );
  }
});

test("every deny exemplar corresponds to a live deny rule (no stale exemplars)", () => {
  const live = new Set(DEFAULT_DENY_RULES.map((r) => r.id));
  for (const id of Object.keys(DENY_EXEMPLARS)) {
    assert.ok(live.has(id), `DENY_EXEMPLARS has stale id "${id}" not in DEFAULT_DENY_RULES`);
  }
});

// ── source coverage: every declared spec source produced scenarios ─────────────
test("every declared scenario source produces at least one scenario", () => {
  for (const source of SCENARIO_SOURCES) {
    const n = generateScenarios({ sources: [source as ScenarioSource] }).length;
    assert.ok(n >= 1, `scenario source "${source}" produced zero scenarios — drift`);
  }
});

test("generateScenarios({ sources }) filters to the requested sources only", () => {
  const onlyRisk = generateScenarios({ sources: ["risk"] });
  assert.ok(onlyRisk.length >= 5);
  assert.ok(onlyRisk.every((s) => s.derivedFrom.startsWith("risk:")));
});

// ── every advisory scenario names a rubric the judge actually knows ────────────
test("every advisory scenario references a defined rubric", () => {
  for (const s of advisoryScenarios()) {
    assert.ok(RUBRICS[s.rubric], `advisory scenario ${s.id} uses unknown rubric "${s.rubric}"`);
  }
});

// ── every risk scenario asserts the dimension it exercises ─────────────────────
test("every risk scenario ties itself to a risk dimension via riskReasonIncludes", () => {
  for (const s of executionScenarios({ sources: ["risk"] })) {
    assert.ok(
      s.expect.riskReasonIncludes,
      `risk scenario ${s.id} must assert the risk reason it exercises`,
    );
  }
});

// ── the opt-in judge leg runs and scores advisory quality ──────────────────────
test("runEvalSuite scores the advisory leg when a judge is supplied (stub, no network)", async () => {
  const suite = await runEvalSuite({ judge: stubJudge });
  assert.ok(suite.advisory, "advisory leg should run when a judge is supplied");
  assert.equal(suite.advisory.total, advisoryScenarios().length);
  // every behaviour scenario: the empowering exemplar must outscore the exploitative one
  assert.equal(
    suite.advisory.passed,
    suite.advisory.total,
    `advisory failures: ${suite.advisory.results.filter((r) => !r.passed).map((r) => r.scenarioId).join(", ")}`,
  );
  // the deterministic gate is unaffected by the judge leg
  assert.equal(suite.ok, true);
});

test("the advisory leg is OFF by default (no judge, no env) — deterministic gate only", async () => {
  const suite = await runEvalSuite();
  assert.equal(suite.advisory, undefined);
  assert.equal(suite.ok, true);
});

test("the dry-run env flag enables the stub judge leg (CI exercises it without a key)", async () => {
  const prev = process.env.GORDON_EVAL_DRY_RUN;
  process.env.GORDON_EVAL_DRY_RUN = "1";
  try {
    const suite = await runEvalSuite();
    assert.ok(suite.advisory);
    assert.equal(suite.advisory.passed, suite.advisory.total);
  } finally {
    if (prev === undefined) delete process.env.GORDON_EVAL_DRY_RUN;
    else process.env.GORDON_EVAL_DRY_RUN = prev;
  }
});

// ── the judge seam stays provider-free (any text completer is a judge) ─────────
test("a custom text-completer judge plugs into the advisory leg unchanged", async () => {
  // A deterministic completer that penalises predatory patterns in the ANSWER
  // (extracted from the rendered prompt so the rubric's own red-flag words don't leak in).
  const judge = llmJudge(async (prompt) => {
    const m = prompt.match(/AGENT ANSWER: ([\s\S]*?)\n\nReply/);
    const answer = m ? m[1] : prompt;
    const red = /act now|must buy|payday|bnpl|hurry|guilty|hopeless|guaranteed returns|you should feel/i.test(answer);
    return `{"score": ${red ? 0.1 : 0.9}, "reason": "stub completer"}`;
  });
  const suite = await runEvalSuite({ judge });
  assert.ok(suite.advisory);
  assert.ok(suite.advisory.passed >= 1);
});
