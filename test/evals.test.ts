import test from "node:test";
import assert from "node:assert/strict";

import {
  generateScenarios,
  executionScenarios,
  scenariosByProvenance,
  runScenario,
  runEvalSuite,
  detectRegressions,
  checkTrajectory,
  computePassK,
  stubJudge,
  type EvalSuiteResult,
} from "../src/evals/index.ts";
import { llmJudge, parseJudgeVerdict, type JudgeModel } from "../src/evals/judge.ts";
import type { AuditEntry } from "../src/core/audit.ts";

// ── scenario generation + provenance ─────────────────────────────────────────
test("scenarios are generated with provenance from authoritative specs", () => {
  const all = generateScenarios();
  assert.ok(all.length >= 6);
  assert.ok(all.every((s) => s.derivedFrom.includes(":")));
  assert.equal(scenariosByProvenance("acceptance:").length, 5);
  // one denylist scenario per LIVE hard deny rule (currently 2)
  assert.equal(scenariosByProvenance("denylist:").length, 2);
  assert.ok(scenariosByProvenance("risk:").length >= 5);
  assert.ok(scenariosByProvenance("mandate:").length >= 5);
  assert.ok(scenariosByProvenance("behaviour:").length >= 5);
});

// ── each scenario reaches its expected gate outcome (live) ───────────────────
test("every generated scenario reaches its expected gate outcome", async () => {
  for (const s of executionScenarios()) {
    const run = await runScenario(s);
    assert.equal(run.result.status, s.expect.status, `${s.id} expected ${s.expect.status}, got ${run.result.status}`);
  }
});

// ── the full suite is green + deterministic ──────────────────────────────────
test("runEvalSuite passes the whole generated suite with no block violations", async () => {
  const r = await runEvalSuite();
  assert.equal(r.ok, true, `failures: ${r.results.filter((x) => !x.passed).map((x) => x.scenarioId).join(", ")}`);
  assert.equal(r.failed, 0);
  // every run produced a clean process check
  assert.ok(r.results.every((x) => x.processOk));
});

test("pass^k mode 'all' holds across repeated deterministic runs", async () => {
  const r = await runEvalSuite({ k: 3, mode: "all" });
  assert.equal(r.ok, true);
  assert.ok(r.results.every((x) => x.passK.k === 3 && x.passK.passes === 3));
});

// ── process checks catch the catastrophic failures ───────────────────────────
function entry(type: AuditEntry["type"], payload: unknown, seq: number): AuditEntry {
  return { seq, ts: "2026-06-24T00:00:00.000Z", type, payload, prevHash: "x", hash: "y", sig: "z" };
}

test("a clean live trajectory has no block violations", async () => {
  const run = await runScenario(executionScenarios()[0]); // auto_execute
  const check = checkTrajectory(run.trajectory);
  assert.equal(check.ok, true);
  assert.equal(check.blockViolations.length, 0);
});

test("process check flags a settlement of a gate-BLOCKED intent (catastrophic)", () => {
  const trace = [
    entry("gate.decision", { intentId: "pi_x", outcome: "block", reasons: ["over cap"], intent: { payee: "p", amount: 999, rail: "card" } }, 1),
    entry("payment.settled", { intentId: "pi_x", receiptId: "r" }, 2), // should be impossible
  ];
  const check = checkTrajectory(trace);
  assert.equal(check.ok, false);
  assert.ok(check.blockViolations.some((v) => v.rule === "settle_blocked_intent"));
});

test("process check flags a settlement with no gate decision at all", () => {
  const trace = [entry("payment.settled", { intentId: "pi_y" }, 1)];
  const check = checkTrajectory(trace);
  assert.equal(check.ok, false);
  assert.ok(check.blockViolations.some((v) => v.rule === "settle_without_gate_decision"));
});

test("process check warns on a doom loop (same intent blocked 3x)", () => {
  const blocked = { intentId: "pi_z", outcome: "block", reasons: ["x"], intent: { payee: "p", amount: 100, rail: "card" } };
  const trace = [entry("gate.decision", { ...blocked }, 1), entry("gate.decision", { ...blocked, intentId: "pi_z2" }, 2), entry("gate.decision", { ...blocked, intentId: "pi_z3" }, 3)];
  const check = checkTrajectory(trace);
  assert.ok(check.violations.some((v) => v.rule === "doom_loop" && v.severity === "warn"));
  // a warn does not fail the gate
  assert.equal(check.ok, true);
});

// ── pass^k unit ──────────────────────────────────────────────────────────────
test("computePassK: 'all' needs every run; 'any' needs one", () => {
  assert.equal(computePassK("s", [true, true, true], "all").passed, true);
  assert.equal(computePassK("s", [true, false, true], "all").passed, false);
  assert.equal(computePassK("s", [false, false, true], "any").passed, true);
  assert.equal(computePassK("s", [], "all").passed, false);
});

// ── regression detection ─────────────────────────────────────────────────────
test("detectRegressions flags a scenario that went pass → fail", () => {
  const base: EvalSuiteResult = {
    total: 2, passed: 2, failed: 0, ok: true,
    results: [
      { scenarioId: "a", derivedFrom: "x", category: "safety", passed: true, expectedStatus: "blocked", actualStatus: "blocked", outcomeOk: true, processOk: true, violations: [], passK: { scenarioId: "a", k: 1, passes: 1, passed: true, fraction: 1 } },
      { scenarioId: "b", derivedFrom: "x", category: "execution", passed: true, expectedStatus: "settled", actualStatus: "settled", outcomeOk: true, processOk: true, violations: [], passK: { scenarioId: "b", k: 1, passes: 1, passed: true, fraction: 1 } },
    ],
  };
  const candidate: EvalSuiteResult = {
    ...base, passed: 1, failed: 1, ok: false,
    results: [base.results[0], { ...base.results[1], passed: false }],
  };
  const report = detectRegressions(base, candidate);
  assert.equal(report.hasBlockingRegression, true);
  assert.equal(report.regressions[0].scenarioId, "b");
});

// ── stub judge ───────────────────────────────────────────────────────────────
test("stub judge scores empowering advice above exploitative advice", async () => {
  const good = await stubJudge.judge({ ask: "help me save", answer: "I can set up a £20 option for you — no rush, your next step is one transfer.", rubric: "advisory" });
  const bad = await stubJudge.judge({ ask: "help me save", answer: "Act now — you must buy this BNPL plan, guaranteed returns!", rubric: "advisory" });
  assert.ok(good.score > bad.score);
});

// ── pluggable judge seam ─────────────────────────────────────────────────────
test("llmJudge adapts any text-completer into a JudgeModel (swappable seam)", async () => {
  // A stub completer standing in for an LLM: it sees the rendered prompt and returns
  // JSON, proving the seam is provider-free and swappable.
  let sawRubric = false;
  const judge: JudgeModel = llmJudge(async (prompt) => {
    sawRubric = prompt.includes("RED FLAGS"); // the advisory rubric was injected
    return 'noise before {"score": 0.91, "reason": "empowering, action-first"} trailing';
  });
  const v = await judge.judge({ ask: "help me save", answer: "...", rubric: "advisory" });
  assert.equal(sawRubric, true);
  assert.equal(v.score, 0.91);
  assert.equal(v.reason, "empowering, action-first");
});

test("parseJudgeVerdict clamps and tolerates messy output", () => {
  assert.equal(parseJudgeVerdict('{"score": 1.7, "reason": "x"}').score, 1);
  assert.equal(parseJudgeVerdict('{"score": -3, "reason": "x"}').score, 0);
  assert.equal(parseJudgeVerdict("not json at all").score, 0.5);
});

test("the harness accepts the adapter anywhere a JudgeModel is expected", async () => {
  // Type-level + behavioural proof: both stubJudge and an llmJudge satisfy JudgeModel.
  const judges: JudgeModel[] = [stubJudge, llmJudge(async () => '{"score":0.5,"reason":"r"}')];
  for (const j of judges) {
    const v = await j.judge({ ask: "a", answer: "b", rubric: "advisory" });
    assert.ok(v.score >= 0 && v.score <= 1);
  }
});
