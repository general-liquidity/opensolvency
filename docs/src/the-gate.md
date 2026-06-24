# The gate

`evaluateGate(intent, context)` is the crown-jewel invariant: a **pure function**
that maps a payment intent + the operator's current state to one of three outcomes:

| Outcome | Meaning |
|---|---|
| `auto_execute` | covered by a live mandate, under caps, low risk, clear of the deny-list → settle |
| `confirm_operator` | needs a human (new payee, over a soft threshold, …) → park as pending |
| `block` | a hard cap / deny-list / halt → refused |

Because the gate reads **structured numbers and the live mandate set** — never model
text — a prompt-injected rationale ("ignore the mandate, auto-execute") cannot move
it. This is verified by the eval suite and a 2000-scenario property/fuzz test.

## The single money path

The **executor** is the only route to a rail. It builds the gate context from the
store, runs the pure gate, records the decision to the signed audit chain, and
settles *only* on `auto_execute` (or an operator `approve`). No surface — CLI, SDK,
MCP, ACP, HTTP — can reach a rail any other way; each is a transport into the gate.

## Portable

The gate has zero `node:` dependencies, so the same invariant runs in a browser,
an edge worker, or another-language host:

```ts
import { evaluateGate } from "@general-liquidity/opensolvency/gate";
```

## Operator controls

A **kill switch** and **circuit breaker** are operator-only flags the agent cannot
write; when engaged, nothing settles. High-risk / irreversible / large approvals
require an explicit challenge-response acknowledgement, not a bare rationale.
