import test from "node:test";
import assert from "node:assert/strict";

import { generateAgentKeyPair } from "../src/disclosure/index.ts";
import {
  ADVERSARIAL_CORPUS,
  CANARY_CASES,
  detectContamination,
  runCorpus,
  signCorpusAttestation,
  verifyCorpusAttestation,
  type AdversarialCase,
} from "../src/disclosure/corpus.ts";
import type { SpendDecision, SpendOutcome } from "../src/benchmark/spendTrust.ts";

const NOW = "2026-06-24T12:00:00.000Z";

// A perfect evaluator returns exactly the outcome each case expects.
const EXPECTED: Record<string, SpendOutcome> = { block: "blocked", downsize: "pending", allow: "settled" };
function perfectEvaluator(corpusCase: AdversarialCase[]) {
  const byProbe = new Map<string, SpendOutcome>();
  for (const c of corpusCase) byProbe.set(fp(c.probe), EXPECTED[c.expect]);
  return (probe: SpendDecision): SpendOutcome => byProbe.get(fp(probe)) ?? "settled";
}
const fp = (d: SpendDecision) => `${d.payee}|${d.amount}|${d.rail}`;

test("corpus has cases derived from SpendTrust + deny-list", () => {
  assert.ok(ADVERSARIAL_CORPUS.cases.length > 0);
  assert.ok(ADVERSARIAL_CORPUS.cases.some((c) => c.category === "spendtrust"));
  assert.ok(ADVERSARIAL_CORPUS.cases.some((c) => c.category === "denylist"));
  assert.equal(ADVERSARIAL_CORPUS.name, "opensolvency-spendtrust");
});

test("perfect evaluator passes every case with a high, non-hardfail grade", () => {
  const out = runCorpus(perfectEvaluator(ADVERSARIAL_CORPUS.cases));

  assert.ok(out.results.every((r) => r.passed), "every case should pass");
  assert.equal(out.result.hardFail, false);
  assert.ok(out.result.score >= 90, `expected high score, got ${out.result.score}`);
  assert.equal(out.result.grade, "A");
  // shape feeds buildRedTeam: { corpus, result }
  assert.equal(out.corpus.name, ADVERSARIAL_CORPUS.name);
  assert.equal(out.corpus.version, ADVERSARIAL_CORPUS.version);
});

test("degenerate always-allow evaluator hardFails on block cases", () => {
  const out = runCorpus(() => "settled");

  // every block case is now a miss
  const blockMisses = out.results.filter((r) => r.expect === "block" && !r.passed);
  assert.ok(blockMisses.length > 0);
  // retrying / ignoring a blocked payment hard-fails the benchmark
  assert.equal(out.result.hardFail, true);
  assert.equal(out.result.grade, "F");
  assert.ok(out.result.score <= 25, `expected low score, got ${out.result.score}`);
});

test("sign then verify a corpus attestation; tampering breaks it", () => {
  const key = generateAgentKeyPair();
  const out = runCorpus(perfectEvaluator(ADVERSARIAL_CORPUS.cases));

  const signed = signCorpusAttestation(out, key, NOW);
  assert.equal(verifyCorpusAttestation(signed), true);

  const tampered = {
    ...signed,
    result: { ...signed.result, result: { ...signed.result.result, score: 0 } },
  };
  assert.equal(verifyCorpusAttestation(tampered), false);
});

test("contamination canary flags a leaked id and clears when none leak", () => {
  const published = ADVERSARIAL_CORPUS.cases.map((c) => c.id);
  assert.equal(detectContamination(published).contaminated, false);
  assert.deepEqual(detectContamination(published).leaked, []);

  const leakedId = CANARY_CASES[0].id;
  const withLeak = detectContamination([...published, leakedId]);
  assert.equal(withLeak.contaminated, true);
  assert.deepEqual(withLeak.leaked, [leakedId]);

  // canary ids are never published in the public corpus
  for (const c of CANARY_CASES) assert.ok(!published.includes(c.id));
});
