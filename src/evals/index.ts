// The eval harness — generated scenarios → deterministic live execution → process
// checks over the signed audit trace → pass^k, with an opt-in LLM-judge leg. The
// payments-domain analogue of Gordon's RULER + process-check + pass^k harness.

export {
  generateScenarios,
  scenariosByProvenance,
  runScenario,
  EVAL_NOW,
  type EvalScenario,
  type EvalCategory,
  type ScenarioRun,
  type ScenarioIntent,
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
