// The eval suite runner + regression detector. Ties the pieces together:
//   1. run each generated EXECUTION scenario live (deterministic executor + FakeRail),
//   2. assert the gate reached the EXPECTED outcome (status + reason / risk-reason),
//   3. run the deterministic process checks over the signed trajectory,
//   4. aggregate pass^k (safety scenarios must hold on every run),
//   5. OPT-IN: score the advisory scenarios with an LLM judge (quality only).
//
// A scenario PASSES iff: the executor status equals `expect.status`, the expected
// reason/risk-reason appears, AND there are no block-severity process violations.
// All three are deterministic, so the gate is a hard CI gate with no model and no
// flakiness. The judge leg ADDS the advisory-quality dimension; it never gates
// safety (that is enforced deterministically) and is off unless a judge is supplied.

import {
  executionScenarios,
  advisoryScenarios as defaultAdvisoryScenarios,
  runScenario,
  type AdvisoryScenario,
  type EvalScenario,
  type ExecutionScenario,
} from "./scenarios.ts";
import { checkTrajectory, type Violation } from "./process.ts";
import { computePassK, type PassKMode, type PassKResult } from "./passK.ts";
import { stubJudge, type JudgeModel } from "./judge.ts";

export interface ScenarioResult {
  scenarioId: string;
  derivedFrom: string;
  category: EvalScenario["category"];
  passed: boolean;
  /** the executor status we got vs what the spec expected */
  expectedStatus: string;
  actualStatus: string;
  outcomeOk: boolean;
  processOk: boolean;
  violations: Violation[];
  passK: PassKResult;
}

export interface AdvisoryResult {
  scenarioId: string;
  derivedFrom: string;
  rubric: string;
  goodScore: number;
  badScore: number;
  /** the empowering exemplar must outscore the exploitative one */
  passed: boolean;
}

export interface AdvisorySuiteResult {
  total: number;
  passed: number;
  results: AdvisoryResult[];
}

export interface EvalSuiteResult {
  total: number;
  passed: number;
  failed: number;
  /** true iff every EXECUTION scenario passed (the deterministic CI gate condition) */
  ok: boolean;
  results: ScenarioResult[];
  /** present only when the opt-in judge leg ran (a judge was supplied / enabled) */
  advisory?: AdvisorySuiteResult;
}

export interface RunEvalOptions {
  /** execution scenarios to run (defaults to the full generated execution set) */
  scenarios?: ExecutionScenario[];
  /** runs per scenario for pass^k (default 1 — the gate path is deterministic, so
   *  k>1 matters once a real agent/model is in the loop). */
  k?: number;
  /** pass^k mode for SAFETY scenarios (default "all"). Execution scenarios use the
   *  same mode; safety is where "all" is non-negotiable. */
  mode?: PassKMode;
  /** OPT-IN LLM-judge leg. Supply a `JudgeModel` (real provider or `stubJudge`) to
   *  score advisory quality. If omitted, the leg runs with `stubJudge` only when a
   *  dry-run env flag is set (so CI exercises it deterministically, no network). */
  judge?: JudgeModel;
  /** advisory scenarios for the judge leg (defaults to the generated behaviour set) */
  advisoryScenarios?: AdvisoryScenario[];
}

/** Resolve the judge for the opt-in leg: an explicitly supplied judge wins; else the
 *  dry-run env flags enable the deterministic stub (CI), else the leg is skipped. */
function resolveJudge(opts: RunEvalOptions): JudgeModel | undefined {
  if (opts.judge) return opts.judge;
  if (process.env.GORDON_EVAL_DRY_RUN === "1" || process.env.AGENTWORTH_EVAL_JUDGE === "stub") {
    return stubJudge;
  }
  return undefined;
}

/** Run one execution scenario once: live execution → outcome + reason checks + process checks. */
async function runOnce(
  scenario: ExecutionScenario,
): Promise<{ ok: boolean; actualStatus: string; violations: Violation[] }> {
  const run = await runScenario(scenario);
  const { decision } = run.result;
  const statusOk = run.result.status === scenario.expect.status;
  const reasonOk =
    !scenario.expect.reasonIncludes ||
    decision.reasons.some((r) => r.includes(scenario.expect.reasonIncludes as string));
  const riskReasonOk =
    !scenario.expect.riskReasonIncludes ||
    decision.risk.reasons.some((r) => r.includes(scenario.expect.riskReasonIncludes as string));
  const check = checkTrajectory(run.trajectory);
  return {
    ok: statusOk && reasonOk && riskReasonOk && check.ok,
    actualStatus: run.result.status,
    violations: check.violations,
  };
}

async function runAdvisoryLeg(
  judge: JudgeModel,
  scenarios: AdvisoryScenario[],
): Promise<AdvisorySuiteResult> {
  const results: AdvisoryResult[] = [];
  for (const s of scenarios) {
    const good = await judge.judge({ ask: s.ask, answer: s.goodAnswer, rubric: s.rubric });
    const bad = await judge.judge({ ask: s.ask, answer: s.badAnswer, rubric: s.rubric });
    results.push({
      scenarioId: s.id,
      derivedFrom: s.derivedFrom,
      rubric: s.rubric,
      goodScore: good.score,
      badScore: bad.score,
      passed: good.score > bad.score,
    });
  }
  return { total: results.length, passed: results.filter((r) => r.passed).length, results };
}

export async function runEvalSuite(opts: RunEvalOptions = {}): Promise<EvalSuiteResult> {
  const scenarios = opts.scenarios ?? executionScenarios();
  const k = opts.k ?? 1;
  const mode = opts.mode ?? "all";

  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    const runs: boolean[] = [];
    let lastStatus = "";
    let lastViolations: Violation[] = [];
    let outcomeOk = true;
    let processOk = true;
    for (let i = 0; i < k; i++) {
      const r = await runOnce(s);
      runs.push(r.ok);
      lastStatus = r.actualStatus;
      lastViolations = r.violations;
      if (r.actualStatus !== s.expect.status) outcomeOk = false;
      if (r.violations.some((v) => v.severity === "block")) processOk = false;
    }
    const passK = computePassK(s.id, runs, mode);
    results.push({
      scenarioId: s.id,
      derivedFrom: s.derivedFrom,
      category: s.category,
      passed: passK.passed,
      expectedStatus: s.expect.status,
      actualStatus: lastStatus,
      outcomeOk,
      processOk,
      violations: lastViolations,
      passK,
    });
  }

  const passed = results.filter((r) => r.passed).length;
  const suite: EvalSuiteResult = {
    total: results.length,
    passed,
    failed: results.length - passed,
    ok: passed === results.length,
    results,
  };

  const judge = resolveJudge(opts);
  if (judge) {
    suite.advisory = await runAdvisoryLeg(judge, opts.advisoryScenarios ?? defaultAdvisoryScenarios());
  }

  return suite;
}

// ── Regression detection (baseline vs candidate) ─────────────────────────────

export interface Regression {
  scenarioId: string;
  was: boolean;
  now: boolean;
}

export interface RegressionReport {
  hasBlockingRegression: boolean;
  regressions: Regression[];
  /** scenarios that went from failing → passing (improvements) */
  fixes: Regression[];
}

/** Compare two suite results: a regression is a scenario that passed in baseline
 *  and fails in candidate. Any such regression blocks (the CI gate). */
export function detectRegressions(
  baseline: EvalSuiteResult,
  candidate: EvalSuiteResult,
): RegressionReport {
  const byId = new Map(baseline.results.map((r) => [r.scenarioId, r.passed]));
  const regressions: Regression[] = [];
  const fixes: Regression[] = [];
  for (const r of candidate.results) {
    const was = byId.get(r.scenarioId);
    if (was === undefined) continue;
    if (was && !r.passed) regressions.push({ scenarioId: r.scenarioId, was, now: r.passed });
    if (!was && r.passed) fixes.push({ scenarioId: r.scenarioId, was, now: r.passed });
  }
  return { hasBlockingRegression: regressions.length > 0, regressions, fixes };
}
