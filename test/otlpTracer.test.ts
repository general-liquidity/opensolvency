import test from "node:test";
import assert from "node:assert/strict";

import { otlpTracer, buildLogPayload, type OtlpFetch } from "../src/obs/otlpTracer.ts";

test("buildLogPayload shapes a valid OTLP LogRecord with service + attributes", () => {
  const p = buildLogPayload("payment.settled", { intentId: "pi_1", amount: 500 }, "agentworth", 1_700_000_000_000) as any;
  const rl = p.resourceLogs[0];
  assert.deepEqual(rl.resource.attributes[0], { key: "service.name", value: { stringValue: "agentworth" } });
  const rec = rl.scopeLogs[0].logRecords[0];
  assert.equal(rec.body.stringValue, "payment.settled");
  assert.equal(rec.timeUnixNano, "1700000000000000000"); // ms → ns
  // non-string attribute values are JSON-stringified
  const amount = rec.attributes.find((a: any) => a.key === "amount");
  assert.equal(amount.value.stringValue, "500");
});

test("otlpTracer POSTs to /v1/logs with the event name as the log body", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fetch: OtlpFetch = async (url, init) => {
    calls.push({ url, body: init.body });
    return { ok: true, status: 200 };
  };
  const tracer = otlpTracer({ endpoint: "http://localhost:4318/", fetch, now: () => 1_700_000_000_000 });
  tracer.event("gate.decision", { outcome: "block" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://localhost:4318/v1/logs"); // trailing slash trimmed
  assert.match(calls[0].body, /gate\.decision/);
});

test("a failing collector never throws out of event() (best-effort)", async () => {
  const fetch: OtlpFetch = async () => {
    throw new Error("collector unreachable");
  };
  const tracer = otlpTracer({ endpoint: "http://x:4318", fetch });
  assert.doesNotThrow(() => tracer.event("payment.failed", {}));
  await Promise.resolve();
});
