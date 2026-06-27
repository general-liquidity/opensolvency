# AG-UI approval surface

[AG-UI](https://docs.ag-ui.com) (the Agent-User Interaction Protocol) is the open
protocol for streaming an agent's run to a frontend as a sequence of typed events.
AgentWorth uses it for one thing: the human-in-the-loop **"confirm with operator"**
flow. When the gate routes a payment to the operator, OS emits the AG-UI
frontend-tool-call sequence for a `confirm_spend` tool, so any AG-UI client renders
*"the agent wants to spend £X — approve / deny"*, pauses, and ships the human's
answer back in the next run.

```ts
import {
  spendApprovalEvents,
  stateSnapshot,
  parseApprovalResult,
  encodeStream,
  CONFIRM_SPEND_TOOL,
} from "@general-liquidity/agentworth/agui";
```

## The decision → events mapping

`spendApprovalEvents({ decision, intent, threadId, runId, toolCallId })` turns one
`GateDecision` into a wire-exact AG-UI event array:

| Gate outcome | Events |
|---|---|
| `confirm_operator` | `RUN_STARTED` → `TOOL_CALL_START(confirm_spend)` → `TOOL_CALL_ARGS` → `TOOL_CALL_END` → `CUSTOM("awaiting_approval")` → `RUN_FINISHED` |
| `auto_execute` | `RUN_STARTED` → `CUSTOM("spend_auto_executed")` → `RUN_FINISHED` |
| `block` | `RUN_STARTED` → `CUSTOM("spend_blocked", { reasons })` → `RUN_FINISHED` |

For `confirm_operator`, the `TOOL_CALL_ARGS.delta` is a JSON string of the
render-ready summary — `{ intentId, payee, amount, currency, decision, reasons }`.
The agent then **pauses**: it has asked a *frontend* tool to run, and waits.

## Human-in-the-loop: the answer comes back as a `tool` message

Per the AG-UI HITL pattern, the operator's decision is **not** a `TOOL_CALL_RESULT`
(that direction is the agent reporting a tool *it* ran). It arrives in the **next
run's** `messages` as a `tool` message:

```json
{ "id": "…", "role": "tool", "content": "approve", "toolCallId": "tc1" }
```

`parseApprovalResult(message)` models that message:

```ts
const { approved, toolCallId } = parseApprovalResult(toolMessage);
```

`approved` is `true` only when the trimmed, lower-cased content is one of
`approve` / `approved` / `yes` / `true`. Everything else — `deny`, `no`, empty —
is **not approved** (deny-by-default). Feed the result back through the SDK's
`approve()` / leave-pending path; the gate is re-run on current state, so a hard
block can never be approved away.

## The state panel

`stateSnapshot({ mandates, decision?, disclosure? })` emits a `STATE_SNAPSHOT`
carrying the operator panel: each mandate's caps, the budget remaining after the
last decision, the last `GateDecision`, and an optional `disclosure` (e.g. an
ADP / OS disclosure object) surfaced in the same panel.

## SSE encoding

Events are streamed as Server-Sent Events:

```ts
res.writeHead(200, { "Content-Type": SSE_CONTENT_TYPE }); // text/event-stream
writeEventsToSse((chunk) => res.write(chunk), events);
```

`encodeSSE(event)` produces a single `data: <json>\n\n` frame; `encodeStream(events)`
concatenates a sequence; `writeEventsToSse(write, events)` pipes into any sink
without OS importing `node:http`.

## A deliberate no-dependency choice

OS does **not** depend on `@ag-ui/core`. AG-UI is pre-1.0 and its client drags in
rxjs; the kernel stays dependency-light. We define the minimal wire-exact AG-UI
event subset locally (`RUN_STARTED`, `TOOL_CALL_*`, `STATE_SNAPSHOT`, `CUSTOM`,
`RUN_FINISHED`, …) and emit canonical JSON over SSE — **wire-compatible with any
`@ag-ui/core`-based client**. The producers are pure and deterministic: the kernel
never reads a clock, so the same inputs yield an identical event array (an optional
injected `now` may stamp `timestamp`).
