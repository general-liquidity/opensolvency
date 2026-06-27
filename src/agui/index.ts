// AG-UI (Agent-User Interaction Protocol) approval surface for AgentWorth.
//
// AG-UI is the open protocol for streaming an agent's run to a frontend as a
// sequence of typed events. AgentWorth uses it for ONE thing: the human-in-the-loop
// "confirm with operator" flow. When the gate returns `confirm_operator`, AgentWorth
// emits the AG-UI frontend-tool-call sequence for a `confirm_spend` tool, so any
// AG-UI client renders "the agent wants to spend $X — approve / deny", pauses,
// and ships the human's answer back as a `tool` message in the next run.
//
// This module is PURE: deterministic event producers + an SSE encoder. It reads
// the clock from nothing (an optional `now` may be injected) and pulls in no new
// dependency — we define the minimal wire-exact AG-UI event subset locally rather
// than take `@ag-ui/core` (pre-1.0, drags in rxjs via its client). The JSON we
// emit is wire-compatible with any `@ag-ui/core`-based client.

import type { GateDecision, Mandate, PaymentIntent } from "../core/types.ts";

// --- The AG-UI event subset (wire-exact) -----------------------------------
//
// EventType values are SCREAMING_SNAKE strings carried in each event's `type`
// field. We model only the subset AgentWorth needs for the approval surface.

export type AguiEventType =
  | "RUN_STARTED"
  | "RUN_FINISHED"
  | "RUN_ERROR"
  | "TOOL_CALL_START"
  | "TOOL_CALL_ARGS"
  | "TOOL_CALL_END"
  | "STATE_SNAPSHOT"
  | "CUSTOM";

/** Every AG-UI event carries its `type` and an optional `timestamp` (ms epoch).
 * The kernel never reads the clock, so `timestamp` is omitted unless a `now` is
 * injected by the caller — keeping the producers deterministic. */
export interface BaseEvent {
  type: AguiEventType;
  timestamp?: number;
}

export interface RunStartedEvent extends BaseEvent {
  type: "RUN_STARTED";
  threadId: string;
  runId: string;
}

export interface RunFinishedEvent extends BaseEvent {
  type: "RUN_FINISHED";
  threadId: string;
  runId: string;
  result?: unknown;
}

export interface RunErrorEvent extends BaseEvent {
  type: "RUN_ERROR";
  message: string;
  code?: string;
}

export interface ToolCallStartEvent extends BaseEvent {
  type: "TOOL_CALL_START";
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
}

export interface ToolCallArgsEvent extends BaseEvent {
  type: "TOOL_CALL_ARGS";
  toolCallId: string;
  /** A fragment of the tool-call arguments as a JSON string (may be streamed in
   * deltas; here we emit the whole argument object as one delta). */
  delta: string;
}

export interface ToolCallEndEvent extends BaseEvent {
  type: "TOOL_CALL_END";
  toolCallId: string;
}

export interface StateSnapshotEvent extends BaseEvent {
  type: "STATE_SNAPSHOT";
  snapshot: unknown;
}

export interface CustomEvent extends BaseEvent {
  type: "CUSTOM";
  name: string;
  value: unknown;
}

export type AguiEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | StateSnapshotEvent
  | CustomEvent;

/** A frontend tool advertised in `RunAgentInput.tools`. `parameters` is a JSON
 * Schema describing the tool's argument object. */
export interface AguiTool {
  name: string;
  description: string;
  parameters: unknown;
}

/** The human's answer comes back in the NEXT run as a `tool` message — NOT as a
 * TOOL_CALL_RESULT (that direction is the agent reporting a tool IT ran). */
export interface ToolMessage {
  id: string;
  role: "tool";
  content: string;
  toolCallId: string;
}

// --- The advertised frontend tool ------------------------------------------

/** Advertise this in `RunAgentInput.tools` so the client knows how to render the
 * approval prompt. The agent never runs it; the human does, and the answer
 * returns as a `tool` message. */
export const CONFIRM_SPEND_TOOL: AguiTool = {
  name: "confirm_spend",
  description:
    "Confirm or deny an agent payment the gate routed to the operator. " +
    "Reply with the operator's decision: approve or deny.",
  parameters: {
    type: "object",
    properties: {
      intentId: { type: "string", description: "The payment intent id" },
      payee: { type: "string", description: "The payee being paid" },
      amount: {
        type: "integer",
        description: "Amount in minor-units (cents / satoshis)",
      },
      currency: { type: "string", description: "ISO-4217 code or token symbol" },
      decision: {
        type: "string",
        enum: ["confirm_operator"],
        description: "The gate outcome that triggered this confirmation",
      },
      reasons: {
        type: "array",
        items: { type: "string" },
        description: "Why the gate routed this to the operator",
      },
    },
    required: ["intentId", "payee", "amount", "currency", "decision", "reasons"],
  },
};

// --- Event producers --------------------------------------------------------

export interface SpendApprovalArgs {
  decision: GateDecision;
  intent: PaymentIntent;
  threadId: string;
  runId: string;
  toolCallId: string;
  /** Parent message id for the tool call (optional, AG-UI threads it through). */
  messageId?: string;
  /** Injected wall-clock ms. Omitted by default to keep producers deterministic;
   * when set, stamped onto every event's `timestamp`. */
  now?: number;
}

/** The argument object encoded into the `confirm_spend` TOOL_CALL_ARGS delta and
 * surfaced to the operator. A compact, render-ready summary of intent + decision. */
export interface ConfirmSpendArgs {
  intentId: string;
  payee: string;
  amount: number;
  currency: string;
  decision: GateDecision["outcome"];
  reasons: string[];
}

function withTs<E extends AguiEvent>(event: E, now?: number): E {
  return now === undefined ? event : { ...event, timestamp: now };
}

/**
 * The core producer. Maps a `GateDecision` onto the AG-UI event sequence:
 *
 *  - `confirm_operator` → RUN_STARTED, TOOL_CALL_START(confirm_spend),
 *    TOOL_CALL_ARGS(delta=JSON of {intent + decision summary}), TOOL_CALL_END,
 *    CUSTOM("awaiting_approval"), RUN_FINISHED. The agent then pauses; the human's
 *    answer arrives as a `tool` message in the next run.
 *  - `auto_execute` → RUN_STARTED, CUSTOM("spend_auto_executed"), RUN_FINISHED.
 *    No human tool call — the gate already authorized it.
 *  - `block` → RUN_STARTED, CUSTOM("spend_blocked", { reasons }), RUN_FINISHED.
 *
 * Deterministic: same inputs → identical array (no clock, no random) unless an
 * explicit `now` is injected.
 */
export function spendApprovalEvents(args: SpendApprovalArgs): AguiEvent[] {
  const { decision, intent, threadId, runId, toolCallId, messageId, now } = args;

  const started: RunStartedEvent = { type: "RUN_STARTED", threadId, runId };
  const finished: RunFinishedEvent = { type: "RUN_FINISHED", threadId, runId };

  if (decision.outcome === "confirm_operator") {
    const confirmArgs: ConfirmSpendArgs = {
      intentId: intent.id,
      payee: intent.payee,
      amount: intent.amount,
      currency: intent.currency,
      decision: decision.outcome,
      reasons: decision.reasons,
    };
    const start: ToolCallStartEvent = {
      type: "TOOL_CALL_START",
      toolCallId,
      toolCallName: CONFIRM_SPEND_TOOL.name,
      ...(messageId === undefined ? {} : { parentMessageId: messageId }),
    };
    const argsEvent: ToolCallArgsEvent = {
      type: "TOOL_CALL_ARGS",
      toolCallId,
      delta: JSON.stringify(confirmArgs),
    };
    const end: ToolCallEndEvent = { type: "TOOL_CALL_END", toolCallId };
    const awaiting: CustomEvent = {
      type: "CUSTOM",
      name: "awaiting_approval",
      value: { intentId: intent.id, toolCallId },
    };
    return [started, start, argsEvent, end, awaiting, finished].map((e) => withTs(e, now));
  }

  if (decision.outcome === "auto_execute") {
    const custom: CustomEvent = {
      type: "CUSTOM",
      name: "spend_auto_executed",
      value: { intent, decision },
    };
    return [started, custom, finished].map((e) => withTs(e, now));
  }

  // block
  const custom: CustomEvent = {
    type: "CUSTOM",
    name: "spend_blocked",
    value: { intent, reasons: decision.reasons },
  };
  return [started, custom, finished].map((e) => withTs(e, now));
}

export interface StateSnapshotArgs {
  mandates: Mandate[];
  decision?: GateDecision;
  /** Optional caller-supplied disclosure (e.g. an ADP / AgentWorth disclosure object) to
   * surface in the same operator panel. */
  disclosure?: unknown;
  now?: number;
}

/** A view of one mandate's budget for the operator panel. */
export interface MandateBudgetView {
  id: string;
  label: string;
  currency: string;
  perTxCap: number;
  perPeriodCap: number;
  /** Period budget left after the last decision, when it matched this mandate. */
  remaining: number | null;
}

export interface OperatorPanelState {
  mandates: MandateBudgetView[];
  lastDecision: GateDecision | null;
  disclosure: unknown;
}

/**
 * A STATE_SNAPSHOT carrying the operator panel: each mandate's caps, the last
 * gate decision, and an optional disclosure. AG-UI clients render this as the
 * shared state panel alongside the run.
 */
export function stateSnapshot(args: StateSnapshotArgs): StateSnapshotEvent {
  const { mandates, decision, disclosure, now } = args;
  const snapshot: OperatorPanelState = {
    mandates: mandates.map((m) => ({
      id: m.id,
      label: m.label,
      currency: m.currency,
      perTxCap: m.perTxCap,
      perPeriodCap: m.perPeriodCap,
      remaining:
        decision && decision.mandateId === m.id ? decision.remainingPeriodBudget : null,
    })),
    lastDecision: decision ?? null,
    disclosure: disclosure ?? null,
  };
  return withTs({ type: "STATE_SNAPSHOT", snapshot }, now);
}

// --- Parsing the human's answer --------------------------------------------

/** Operator answers that count as approval (case-insensitive, trimmed). Anything
 * else — "deny", "no", "reject", empty — is treated as NOT approved (deny-by-default). */
const APPROVE_VOCABULARY = new Set(["approve", "approved", "yes", "true"]);

export interface ApprovalResult {
  toolCallId: string;
  approved: boolean;
  /** The raw, untrimmed content as it arrived. */
  raw: string;
}

/**
 * Parse the human's answer from the `tool` message AG-UI delivers in the next
 * run. `approved` is true only when the trimmed, lower-cased content is one of
 * {"approve","approved","yes","true"} — deny-by-default for everything else.
 */
export function parseApprovalResult(message: ToolMessage): ApprovalResult {
  const normalized = message.content.trim().toLowerCase();
  return {
    toolCallId: message.toolCallId,
    approved: APPROVE_VOCABULARY.has(normalized),
    raw: message.content,
  };
}

// --- SSE encoding -----------------------------------------------------------

/** The content-type AG-UI streams over. */
export const SSE_CONTENT_TYPE = "text/event-stream";

/** Encode one event as an SSE frame: `data: <json>\n\n`. */
export function encodeSSE(event: AguiEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Encode a whole event sequence as concatenated SSE frames. */
export function encodeStream(events: AguiEvent[]): string {
  return events.map(encodeSSE).join("");
}

/** Pipe a sequence into any sink (e.g. a Node `ServerResponse.write`) without AgentWorth
 * importing `node:http`. */
export function writeEventsToSse(
  write: (chunk: string) => void,
  events: AguiEvent[],
): void {
  for (const event of events) {
    write(encodeSSE(event));
  }
}
