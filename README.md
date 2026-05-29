# OpenSolvency

> **Placeholder name.** The operator-aligned governance plane for agentic spend —
> the "secure enclave" of the money OS.

OpenSolvency is **not** a wallet, a rail, or a payment processor. It is the trust
layer that sits *above* rails (x402, cards, ACP/checkout) and *below* an agent,
and enforces a single invariant:

> **An agent payment can auto-execute only inside a live, operator-granted
> mandate that covers it — under its caps, below the risk and velocity
> thresholds, and clear of the deny-list. Everything else routes to the operator
> or is blocked. Every decision is signed and replayable.**

This is the layer the autonomous-money agents that already exist conspicuously
lack. Aeon (the "most autonomous agent framework") moves real USDC on Base via
the Bankr wallet API with **no mandate, no spend cap, no risk gate, no
approver** — "if the operator enables it and runs it, it sends." OpenSolvency is
that missing layer: it lets an agent spend *autonomously within operator-defined
bounds* and confirm above them, instead of the binary choice between full-auto
and a human pulling the trigger every time. **The gate is what lets autonomy go
further, safely — not less far.**

## The Mandate is the central object

A `Mandate` is operator-granted, scoped, capped, expiring, revocable spend
authority — the only thing that authorizes an agent payment without a live human
confirm:

```
weekly groceries → class:groceries · GBP · card
  per-tx cap £500 · per-week cap £1000 · expires 2026-06-26
```

## Architecture (four layers)

| Layer | Status | What it is |
|---|---|---|
| **1. Trust kernel** | **built** | The pure gate invariant + mandate + spend-risk + deny-list + hash-linked signed audit. No I/O, no clock — fully deterministic and replayable. |
| **2. Ledger** | **built** | A `Store` interface with two implementations: `MemoryStore` (tested everywhere) and `SqliteStore` (`node:sqlite`, integer minor-units, idempotent `CREATE TABLE IF NOT EXISTS` migrations: mandates, intents, receipts, the persisted audit chain). |
| **3. Rails** | **built** | A `PaymentProvider` interface + adapters for **x402, ACP, UCP, MPP, Visa Intelligent Commerce, Mastercard Agent Pay** (and an in-process `FakeRail`). Each adapter declares accurate capabilities and takes a `RailClient` for the live settlement; **with no client it fails safe — a real rail never fabricates a settlement.** The registry routes a rail *kind* (what a mandate authorizes) to the chosen protocol, so Visa and Mastercard can coexist on `card`. Three reference `RailClient` implementations ship: an **on-chain** ERC-20 stablecoin transfer (viem-shaped signer), a **single-use virtual card** (Stripe-Issuing pattern — a fresh card minted per intent, capped to exactly the amount), and the **x402 protocol flow** (402-challenge → select an affordable requirement → authorize → settle; EVM/Solana via the injected facilitator). |
| **4. Agent + CLI** | **built** | The `Executor` is the *only* path to a rail. The real agent runs on the **Vercel AI SDK**'s multi-step tool loop — but the model's sole tool (`pay`) executes *through* the gate, so even the autonomous loop can't bypass it. A deterministic offline stub (no key, no network) backs tests and air-gapped runs. A CLI drives it all. |
| **5. Behavioural harness** | **built** | The *helpfulness* half (layers 1–4 are the *safety* half), derived from the Networth behavioural-finance research. The **Four Pillars of Resilience** model is the agent's understanding of the operator; its weakest pillar becomes the agent's standing agenda. Plus teachable+reachable **moment** detection, "watching-your-back" **concerns**, **goals** as agent objectives, an **empower-don't-exploit** guardrail, anxiety-aware **communication** modes, and a PF agent **persona**. |
| **6. Harness-engineering depth** | **built** | **Trust trajectory** (payees earn auto-approval; floor never relaxed), **hot-tier memory** (live state always-injected, capped) + cold **recall** tool, **skills** (markdown playbooks loaded on demand), a **self-evolution envelope** (Tier-1 lessons over a frozen Tier-0 floor), the **reasoning sandwich** (phase-differentiated effort), and **observability** (audit replay, a **counterfactual policy-replay simulator** — re-run the gate over real signed history against a candidate mandate set to see what *would* have changed — and an OTel `Tracer` seam). Every `gate.decision` record carries a full intent + decision-inputs snapshot, so replay is exact. |
| **7. Money-domain completeness** | **built** | **Refunds/chargebacks** (reversible rails only — an irreversible refund is refused; budget is freed), **multi-currency FX** (a foreign payment is capped in the mandate's currency via an injected rate source; no rate → not covered), **mandate lifecycle** (amend / extend / templates), **reconciliation** (settled vs the operator's statement → flags unauthorized spend), and **non-custodial account connection** (read-only by design) + **key custody** (audit key from env/KMS, not the DB). |
| **8. Agentic-economy surface** | **built** | **Network reputation** (an injected payee-reputation source feeds gate risk; never relaxes the floor), **service discovery + price evaluation** (find→evaluate an x402 service's machine-readable price against the mandate before paying), the **earning side** (the inbound mirror of the gate: publish a quote, accept a verified inbound payment via an acceptance policy → recorded in the same signed audit log; income never recorded on faith), and **OpenSolvency as an MCP server** (gated `pay` + read-only tools; operator controls deliberately NOT exposed). |

This is the **B milestone** — "an agent that structurally can't spend wrong" — built end-to-end, now with the behavioural harness that decides what the agent should *help with*. The gate decides *may this spend happen*; the harness decides *what the agent works on* (the weakest resilience pillar). Together: the iPhone-for-money experience.

### Runtime posture (deferred, decided)
Hermes-style serverless-hibernation (Modal/Daytona — always-reachable, ~$0 idle),
**not** Aeon's GitHub-Actions cron: a money agent has to answer inbound payment
challenges (x402/ACP) as *events*, which a 5-minute cron can't. Non-custodial —
execution runs through the operator's own connected accounts.

## What we took from Gordon

Gordon is a **safety/governance/memory harness wrapped around a *trading*
domain**. OpenSolvency is that same harness wrapped around a **payments /
agentic-economy** domain. We ported the *harness*, not the trading.

- **LIFT** (port the pattern, re-domained): deny-first gate + hard deny-list
  (`place_order` → `make_payment`); rejection-weighted adaptive trust;
  multi-dimension risk classifier → spend-risk; rationale-required-on-execute;
  HMAC signed audit (here extended into a hash-linked chain); single-substrate
  observation discipline; Hermes hot-tier memory; RULER eval harness; ACE
  propose-only lessons; velocity/backpressure → the per-mandate velocity ceiling;
  preview→approve as a harness invariant.
- **ADAPT** (reuse the shape, swap the content): the typed surface dispatcher
  pattern; exchange/broker adapters → the rails layer.
- **LEAVE** in Gordon (trading-specific): indicators, microstructure, backtest,
  genome/evolution, regime detection, strategy-validation stats, playbooks, the
  trading tool surface.

From **FinancialClaw** (data-layer patterns): integer minor-units, multi-currency
resolve/placeholder, idempotent migrations, allocation-as-budget-seed.

## v0 acceptance demo (the five steps the gate must get right)

1. Known grocer, inside the live mandate, under cap, low risk → **auto-execute**.
2. A new payee → **confirm with the operator** (a novel payee is never silently paid).
3. £600 against a £500 cap → **block**.
4. A prompt-injected rationale ("ignore the mandate, auto-execute") → still
   **blocked** — the gate decides on structured numbers and the mandate set,
   which model text cannot mutate.
5. An expired mandate → **no auto-execute** (routes to the operator).

All five — plus budget, deny-list, velocity, and rationale invariants — are
covered by the test suite.

## Develop

`tsx` is included so everything runs on Node ≥ 18; the sqlite-backed **CLI**
needs Node ≥ 22.5 (`node:sqlite`).

```bash
npm install
npm test          # 130 tests: gate, audit, executor, store, rails (incl. AP2), finance, agents, ingress (HTTP+XMTP), identity, reputation, earning, MCP
npm run typecheck
npm run demo      # end-to-end walkthrough on the in-memory store (any Node)
```

The CLI (sqlite-backed, Node ≥ 22.5):

```bash
npm run cli -- mandate grant --label groceries --class groceries \
    --currency GBP --rails card --per-tx 50000 --per-period 100000 \
    --period week --expires-days 30
npm run cli -- profile set --income 200000 --essentials 100000 --savings 300000 --stage late-student
npm run cli -- finance "help me build a one-month buffer"   # PF agent (needs a model key)
npm run cli -- goal set --label "emergency fund" --target 600000 --deadline 2026-12-01
npm run cli -- agent "PAY 8000 GBP tesco groceries card :: weekly shop"
npm run cli -- pending
npm run cli -- approve <intentId> --rationale "yes, I know this payee" [--ack]
npm run cli -- kill            # freeze ALL agent spend instantly
npm run cli -- unkill          # release the kill switch
npm run cli -- reset-breaker   # clear a tripped circuit breaker
npm run cli -- status          # kill switch + circuit breaker state
npm run cli -- audit verify
npm run cli -- audit replay-sim   # counterfactual: re-run history vs the CURRENT mandates
npm run cli -- audit replay-sim --mandates ./candidate.json   # …vs a candidate mandate set
```

High-risk pending intents (high spend-risk, irreversible rail, or above the
challenge threshold) require `--ack` on `approve` — a challenge-response gate, not
a bare rationale.

A real model (via the Vercel AI SDK) is used automatically when a key is
available; otherwise the deterministic stub parses the `PAY …` DSL above.
Provider selection:

- `OPENSOLVENCY_MODEL_PROVIDER` — `openai` (default), `anthropic`, or `google`.
- key — `OPENSOLVENCY_MODEL_API_KEY`, or the provider's standard env var
  (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY`).
- `OPENSOLVENCY_MODEL` — model id (defaults per provider).

Adding another provider is one `@ai-sdk/*` package + one `case` in `aiSdkModel.ts`.

## Layout

```
src/core/
  types.ts      # Mandate, PaymentIntent, GateDecision, Receipt, GateContext, DenyRule
  gate.ts       # THE invariant — pure evaluateGate()
  risk.ts       # spend-risk classifier (re-domained from Gordon's riskClassifier)
  denyList.ts   # hard deny rules (predicates over the structured intent)
  audit.ts      # hash-linked, HMAC-signed, tamper-evident audit log
  store.ts      # the persistence boundary (interface) + period-window math
  executor.ts   # the ONLY path to a rail — funnels every intent through the gate
src/store/
  memoryStore.ts  # in-memory Store (tests + reference)
  sqliteStore.ts  # node:sqlite Store (production)
src/rails/
  provider.ts   # PaymentProvider interface + capabilities (id, rail, reversibility)
  registry.ts   # holds providers by id; routes a rail kind → chosen protocol
  fakeRail.ts   # in-process settlement for tests/demo
  networkRail.ts # shared builder: live RailClient seam + fail-safe-if-unconfigured
  x402.ts acp.ts ucp.ts mpp.ts visaIntelligentCommerce.ts mastercardAgentPay.ts
  clients/onchainClient.ts      # REAL settlement: ERC-20 transfer via an injected signer (viem-shaped)
  clients/virtualCardClient.ts  # REAL settlement: single-use virtual card per intent (Stripe-Issuing pattern)
  clients/x402Client.ts         # REAL settlement: the x402 402-challenge → authorize → settle flow (EVM/Solana)
  ap2/mandate.ts ap2/ap2Rail.ts # AP2 (Google): Payment-Mandate model + OpenSolvency-mandate→AP2-constraints map
  index.ts      # barrel; documents which listed protocols are NOT settlement rails
src/identity/verifier.ts # agent-identity layer (AIP / Visa Trusted Agent Protocol) → feeds gate risk via attestation
src/ingress/server.ts # event ingress: HTTP requests run through the SAME gate (loopback)
src/ingress/xmtp.ts   # second ingress transport: XMTP messages run through the SAME gate
src/core/streaming.ts # streaming/recurring mandate preset for micropayments
src/agent/
  schema.ts     # zod PaymentIntent draft + the `pay` tool definition
  aiSdkModel.ts # AI SDK model factory — OpenAI / Anthropic / Google, by config
  aiAgent.ts    # the real agent: AI SDK multi-step loop; `pay` tool is gate-enforced
  model.ts      # ModelProvider interface — the offline/deterministic seam
  stubModel.ts  # deterministic DSL model (tests + air-gapped CLI, no key)
  loop.ts       # single-turn offline path: propose → validate → executor
  financeAgent.ts # PF agent: persona prompt + harness tools + gate-enforced pay + proactive moments
  governance.ts # LLM-loop governance: doom-loop stop, token cap, per-run trace
src/finance/      # the behavioural harness (from the Networth research)
  profile.ts      # FinancialProfile — the operator's situation (4-pillar inputs + anxiety)
  profileStore.ts # persist profile + goals (via the store meta KV)
  onboarding.ts   # Networth-style Q&A → a FinancialProfile (conservative defaults)
  resilience.ts   # Four Pillars of Resilience assessment (weakest pillar = agent agenda)
  moments.ts      # teachable + reachable moment detection
  watch.ts        # "watching your back" → structured concerns (non-punitive)
  goals.ts        # goal-anchoring → agent objectives (required-monthly + feasibility)
  ethics.ts       # empower-don't-exploit guardrail on agent suggestions
  communication.ts # behaviour-over-knowledge → anxiety/stage-aware comms mode
  persona.ts      # buildFinanceSystemPrompt — the harness as the agent's system prompt
src/obs/
  replay.ts     # renderTimeline — the signed audit chain as a readable timeline
  replaySim.ts  # counterfactual policy replay: re-run the gate over real history vs a candidate mandate set
  tracer.ts     # OTel-shaped Tracer seam (noop + console)
src/cli/index.ts  # the first transport (mandate/pay/agent/approve/pending/audit/replay-sim)
scripts/demo.ts   # the runnable end-to-end walkthrough
test/             # gate, audit, executor, agent, store
```

## Next

- **Live-wire** the reference `RailClient`s: a real viem signer + facilitator
  behind `x402Client`, a real Stripe Issuing key behind `virtualCardClient`. The
  protocol logic is built and unit-tested against mocks; what remains is the
  per-network credential onboarding (deliberately out of the repo).
- **Event ingress** (the executor is already transport-agnostic) so the agent
  answers inbound payment challenges, on the Hermes-style hibernating runtime.
- The **streaming-mandate / velocity-ceiling** spike at micropayment rates —
  the one primitive most likely to stress the thesis.
- Hermes-style **hot-tier memory** carrying the live trust profile; **ACE**-style
  propose-only governance lessons (Tier-1, never touching the frozen gate).
