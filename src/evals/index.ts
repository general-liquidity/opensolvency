// The eval harness — generated scenarios → deterministic live execution → process
// checks over the signed audit trace → pass^k, with an opt-in LLM-judge leg. The
// payments-domain analogue of Gordon's RULER + process-check + pass^k harness.

export {
  generateScenarios,
  executionScenarios,
  advisoryScenarios,
  scenariosByProvenance,
  runScenario,
  EVAL_NOW,
  SCENARIO_SOURCES,
  DENY_EXEMPLARS,
  type EvalScenario,
  type ExecutionScenario,
  type AdvisoryScenario,
  type EvalCategory,
  type ScenarioSource,
  type ScenarioRun,
  type ScenarioIntent,
  type SeededSpend,
} from "./scenarios.ts";
export {
  checkTrajectory,
  type NormalizedTrace,
  type ProcessCheckResult,
  type Violation,
  type ViolationSeverity,
} from "./process.ts";
export { computePassK, type PassKMode, type PassKResult } from "./passK.ts";
export {
  runEvalSuite,
  detectRegressions,
  type EvalSuiteResult,
  type ScenarioResult,
  type AdvisoryResult,
  type AdvisorySuiteResult,
  type RunEvalOptions,
  type RegressionReport,
  type Regression,
} from "./harness.ts";
export {
  stubJudge,
  RUBRICS,
  llmJudge,
  buildJudgePrompt,
  parseJudgeVerdict,
  type JudgeModel,
  type JudgeInput,
  type JudgeVerdict,
  type TextCompleter,
} from "./judge.ts";
