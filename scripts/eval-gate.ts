#!/usr/bin/env node
// CI eval gate. Runs the generated scenario suite live (deterministic executor +
// FakeRail), applies the process checks, and exits non-zero if ANY scenario fails
// its expected outcome or trips a block-severity process violation. No model, no
// network — a hard, deterministic gate, the analogue of Gordon's eval-gate.

import { runEvalSuite, stubJudge } from "../src/evals/index.ts";

async function main(): Promise<void> {
  // The advisory leg runs with the DETERMINISTIC stub judge, so behavioural quality
  // (empower-don't-exploit, anxiety-aware comms) is a real CI gate with no model or
  // network: an exploitative answer scoring >= the empowering one fails the build.
  const suite = await runEvalSuite({ k: 1, mode: "all", judge: stubJudge });

  for (const r of suite.results) {
    const mark = r.passed ? "✓" : "✗";
    const detail = r.passed
      ? `${r.actualStatus}`
      : `expected ${r.expectedStatus}, got ${r.actualStatus}` +
        (r.processOk ? "" : ` | ${r.violations.filter((v) => v.severity === "block").map((v) => v.rule).join(", ")}`);
    console.log(`${mark} ${r.scenarioId.padEnd(36)} [${r.derivedFrom}] ${detail}`);
  }
  console.log(`\n${suite.passed}/${suite.total} scenarios passed.`);

  let advisoryFailed = false;
  if (suite.advisory) {
    console.log("\n-- advisory (behavioural) leg --");
    for (const a of suite.advisory.results) {
      const mark = a.passed ? "✓" : "✗";
      console.log(`${mark} ${a.scenarioId.padEnd(36)} [${a.derivedFrom}] good=${a.goodScore} bad=${a.badScore}`);
    }
    console.log(`${suite.advisory.passed}/${suite.advisory.total} advisory scenarios passed.`);
    advisoryFailed = suite.advisory.passed !== suite.advisory.total;
  }

  if (!suite.ok) {
    console.error("\nEVAL GATE FAILED — a gate decision or process check regressed.");
    process.exit(1);
  }
  if (advisoryFailed) {
    console.error(
      "\nEVAL GATE FAILED — a behavioural scenario regressed (the rubric rated an exploitative answer at or above the empowering one).",
    );
    process.exit(1);
  }
  console.log("eval gate: PASS");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
