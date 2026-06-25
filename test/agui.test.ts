import test from "node:test";
import assert from "node:assert/strict";

import {
  CONFIRM_SPEND_TOOL,
  encodeSSE,
  encodeStream,
  parseApprovalResult,
  SSE_CONTENT_TYPE,
  spendApprovalEvents,
  stateSnapshot,
  writeEventsToSse,
  type AguiEvent,
  type ConfirmSpendArgs,
  type OperatorPanelState,
  type ToolMessage,
} from "../src/agui/index.ts";
import type { GateDecision, Mandate, PaymentIntent } from "../src/core/types.ts";

function intent(over: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: "pi_1",
    payee: "tesco",
    payeeClass: "groceries",
    amount: 80_00,
    currency: "GBP",
    rail: "card",
    rationale: "the weekly grocery shop",
    createdAt: "2026-06-25T10:00:00.000Z",
    ...over,
  };
}

function decision(over: Partial<GateDecision> = {}): GateDecision {
  return {
    outcome: "confirm_operator",
    reasons: ["new payee"],
    mandateId: "m_1",
    risk: { tier: "low", score: 1, reasons: [] },
    remainingPeriodBudget: 420_00,
    ...over,
  };
}

function mandate(over: Partial<Mandate> = {}): Mandate {
  return {
    id: "m_1",
    label: "weekly groceries",
    scope: { kind: "class", value: "groceries" },
    currency: "GBP",
    allowedRails: ["card"],
    perTxCap: 100_00,
    perPeriodCap: 500_00,
    period: "week",
    grantedAt: "2026-06-01T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    status: "active",
    ...over,
  };
}

const base = { threadId: "t1", runId: "r1", toolCallId: "tc1" };

test("confirm_operator emits the HITL frontend-tool-call sequence in order", () => {
  const events = spendApprovalEvents({ decision: decision(), intent: intent(), ...base });
  assert.deepEqual(
    events.map((e) => e.type),
    [
      "RUN_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "CUSTOM",
      "RUN_FINISHED",
    ],
  );

  const start = events[1];
  assert.equal(start.type, "TOOL_CALL_START");
  if (start.type === "TOOL_CALL_START") {
    assert.equal(start.toolCallName, "confirm_spend");
    assert.equal(start.toolCallName, CONFIRM_SPEND_TOOL.name);
    assert.equal(start.toolCallId, "tc1");
  }

  // ARGS delta round-trips to the intent + decision summary.
  const argsEvent = events[2];
  assert.equal(argsEvent.type, "TOOL_CALL_ARGS");
  if (argsEvent.type === "TOOL_CALL_ARGS") {
    const parsed = JSON.parse(argsEvent.delta) as ConfirmSpendArgs;
    assert.equal(parsed.intentId, "pi_1");
    assert.equal(parsed.payee, "tesco");
    assert.equal(parsed.amount, 80_00);
    assert.equal(parsed.currency, "GBP");
    assert.equal(parsed.decision, "confirm_operator");
    assert.deepEqual(parsed.reasons, ["new payee"]);
  }

  const end = events[3];
  assert.equal(end.type, "TOOL_CALL_END");
  if (end.type === "TOOL_CALL_END") assert.equal(end.toolCallId, "tc1");
});

test("messageId threads through as parentMessageId when provided", () => {
  const without = spendApprovalEvents({ decision: decision(), intent: intent(), ...base });
  const start = without[1];
  if (start.type === "TOOL_CALL_START") {
    assert.equal(start.parentMessageId, undefined);
  }

  const withId = spendApprovalEvents({
    decision: decision(),
    intent: intent(),
    ...base,
    messageId: "msg_9",
  });
  const start2 = withId[1];
  if (start2.type === "TOOL_CALL_START") {
    assert.equal(start2.parentMessageId, "msg_9");
  }
});

test("auto_execute emits a CUSTOM spend_auto_executed and NO tool call", () => {
  const events = spendApprovalEvents({
    decision: decision({ outcome: "auto_execute", reasons: ["within mandate"] }),
    intent: intent(),
    ...base,
  });
  assert.deepEqual(
    events.map((e) => e.type),
    ["RUN_STARTED", "CUSTOM", "RUN_FINISHED"],
  );
  assert.ok(!events.some((e) => e.type.startsWith("TOOL_CALL")));
  const custom = events[1];
  assert.equal(custom.type, "CUSTOM");
  if (custom.type === "CUSTOM") {
    assert.equal(custom.name, "spend_auto_executed");
    assert.deepEqual((custom.value as { intent: PaymentIntent }).intent.id, "pi_1");
  }
});

test("block emits a CUSTOM spend_blocked carrying the reasons", () => {
  const events = spendApprovalEvents({
    decision: decision({ outcome: "block", reasons: ["deny-list: sanctioned payee"] }),
    intent: intent(),
    ...base,
  });
  assert.deepEqual(
    events.map((e) => e.type),
    ["RUN_STARTED", "CUSTOM", "RUN_FINISHED"],
  );
  const custom = events[1];
  assert.equal(custom.type, "CUSTOM");
  if (custom.type === "CUSTOM") {
    assert.equal(custom.name, "spend_blocked");
    assert.deepEqual(
      (custom.value as { reasons: string[] }).reasons,
      ["deny-list: sanctioned payee"],
    );
  }
});

test("stateSnapshot carries the mandate caps and last decision", () => {
  const event = stateSnapshot({ mandates: [mandate()], decision: decision() });
  assert.equal(event.type, "STATE_SNAPSHOT");
  const snap = event.snapshot as OperatorPanelState;
  assert.equal(snap.mandates.length, 1);
  assert.equal(snap.mandates[0].id, "m_1");
  assert.equal(snap.mandates[0].perTxCap, 100_00);
  assert.equal(snap.mandates[0].perPeriodCap, 500_00);
  // remaining is surfaced because the decision matched this mandate.
  assert.equal(snap.mandates[0].remaining, 420_00);
  assert.equal(snap.lastDecision?.outcome, "confirm_operator");
  assert.equal(snap.disclosure, null);
});

test("stateSnapshot surfaces an optional disclosure and null remaining off-match", () => {
  const event = stateSnapshot({
    mandates: [mandate({ id: "m_other" })],
    decision: decision(),
    disclosure: { kind: "adp", id: "d1" },
  });
  const snap = event.snapshot as OperatorPanelState;
  // decision.mandateId is m_1, mandate is m_other → remaining null.
  assert.equal(snap.mandates[0].remaining, null);
  assert.deepEqual(snap.disclosure, { kind: "adp", id: "d1" });
});

test("stateSnapshot with no decision yields lastDecision null", () => {
  const event = stateSnapshot({ mandates: [mandate()] });
  const snap = event.snapshot as OperatorPanelState;
  assert.equal(snap.lastDecision, null);
  assert.equal(snap.mandates[0].remaining, null);
});

test("parseApprovalResult maps the approve vocabulary to true, else false", () => {
  const mk = (content: string): ToolMessage => ({
    id: "tm1",
    role: "tool",
    content,
    toolCallId: "tc1",
  });
  for (const yes of ["approve", "APPROVED", " Yes ", "true"]) {
    assert.equal(parseApprovalResult(mk(yes)).approved, true, yes);
  }
  for (const no of ["deny", "no", "reject", "", "approve later", "maybe"]) {
    assert.equal(parseApprovalResult(mk(no)).approved, false, no);
  }
  const r = parseApprovalResult(mk("approve"));
  assert.equal(r.toolCallId, "tc1");
  assert.equal(r.raw, "approve");
});

test("encodeSSE produces a data frame whose JSON round-trips with the right type", () => {
  const events = spendApprovalEvents({ decision: decision(), intent: intent(), ...base });
  const frame = encodeSSE(events[0]);
  assert.ok(frame.startsWith("data: "));
  assert.ok(frame.endsWith("\n\n"));
  const json = frame.slice("data: ".length, -2);
  const parsed = JSON.parse(json) as AguiEvent;
  assert.equal(parsed.type, "RUN_STARTED");
  assert.equal(SSE_CONTENT_TYPE, "text/event-stream");
});

test("encodeStream concatenates one frame per event", () => {
  const events = spendApprovalEvents({ decision: decision(), intent: intent(), ...base });
  const stream = encodeStream(events);
  const frames = stream.split("\n\n").filter((f) => f.length > 0);
  assert.equal(frames.length, events.length);
});

test("writeEventsToSse pipes one frame per event into the sink", () => {
  const chunks: string[] = [];
  const events = spendApprovalEvents({ decision: decision(), intent: intent(), ...base });
  writeEventsToSse((c) => chunks.push(c), events);
  assert.equal(chunks.length, events.length);
  assert.equal(chunks.join(""), encodeStream(events));
});

test("producers are deterministic: same inputs → identical event array", () => {
  const a = spendApprovalEvents({ decision: decision(), intent: intent(), ...base });
  const b = spendApprovalEvents({ decision: decision(), intent: intent(), ...base });
  assert.deepEqual(a, b);
  // no timestamps by default
  assert.ok(a.every((e) => e.timestamp === undefined));
});

test("an injected now stamps every event timestamp", () => {
  const events = spendApprovalEvents({
    decision: decision(),
    intent: intent(),
    ...base,
    now: 1_700_000_000_000,
  });
  assert.ok(events.every((e) => e.timestamp === 1_700_000_000_000));
});

test("CONFIRM_SPEND_TOOL advertises a JSON-Schema object with the required fields", () => {
  assert.equal(CONFIRM_SPEND_TOOL.name, "confirm_spend");
  const params = CONFIRM_SPEND_TOOL.parameters as {
    type: string;
    required: string[];
  };
  assert.equal(params.type, "object");
  assert.deepEqual(
    [...params.required].sort(),
    ["amount", "currency", "decision", "intentId", "payee", "reasons"],
  );
});
