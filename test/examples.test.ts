import test from "node:test";
import assert from "node:assert/strict";

import { runShoppingAgentExample } from "../examples/shopping-agent.ts";

test("the shopping-agent example demonstrates all four gate verdicts", async () => {
  const steps = await runShoppingAgentExample();
  const byLabel = Object.fromEntries(steps.map((s) => [s.label, s.status]));
  assert.equal(byLabel["known grocer, under cap"], "settled");
  assert.equal(byLabel["brand-new payee"], "pending");
  assert.equal(byLabel["over the £500 cap"], "blocked");
  // the injected rationale changes nothing — still blocked (over cap)
  assert.equal(byLabel["prompt-injected rationale"], "blocked");
});
