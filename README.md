<!-- prettier-ignore -->
<div align="center">

# OpenSolvency

### The operator-aligned governance plane for agentic spend

*Autonomous-money agents already move real funds with no mandate, no cap, no risk gate, and no approver. OpenSolvency is the missing layer — it lets an agent spend autonomously **inside** operator-defined bounds, and confirm above them.*

[![CI](https://img.shields.io/github/actions/workflow/status/general-liquidity/opensolvency/ci.yml?style=flat-square&label=CI)](https://github.com/general-liquidity/opensolvency/actions)
[![tests](https://img.shields.io/badge/tests-337%20passing-success?style=flat-square)](#develop)
[![node](https://img.shields.io/badge/node-%E2%89%A522.18-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](#develop)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](#license)
[![type](https://img.shields.io/badge/types-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](#tech-stack)

**[Why](#why) · [Quickstart](#quickstart) · [Surfaces](#use-it-from-anywhere) · [Integrations](#integrations) · [What it enforces](#what-it-enforces) · [Architecture](#architecture) · [Tech stack](#tech-stack)**

</div>

---

## Why

OpenSolvency is **not** a wallet, a rail, or a payment processor. It is the trust layer that sits *above* rails (x402, cards, ACP/checkout) and *below* an agent, enforcing a single invariant:

> **An agent payment can auto-execute only inside a live, operator-granted mandate that covers it — under its caps, below the risk and velocity thresholds, and clear of the deny-list. Everything else routes to the operator or is blocked. Every decision is signed and replayable.**

This is the layer the autonomous-money agents that already exist conspicuously lack. Aeon — billed as the "most autonomous agent framework" — moves real USDC on Base via a wallet API with **no mandate, no spend cap, no risk gate, no approver**: if the operator enables it and runs it, it sends. That forces a binary choice — full-auto, or a human pulling the trigger every single time.

OpenSolvency removes the binary. The mandate is what authorizes spend *without* a live human confirm, so the agent acts freely inside the envelope and escalates outside it. **The gate is what lets autonomy go further, safely — not less far.**

#### The Mandate is the central object

A `Mandate` is operator-granted, scoped, capped, expiring, revocable spend authority — the only thing that authorizes an agent payment without a live human confirm:

```
weekly groceries → class:groceries · GBP · card
  per-tx cap £500 · per-week cap £1000 · expires 2026-06-26
```

The gate decides *may this spend happen*; a second, behavioural half (the Networth-derived **harness**) decides *what the agent should help with* — the operator's weakest resilience pillar. Together: the iPhone-for-money experience, with a secure enclave at its core.

## Status — built end-to-end (pre-1.0)

The **B milestone** — "an agent that structurally can't spend wrong" — is built, tested, and CI-green: kernel, ledger, rails, agent loop, behavioural harness, money-domain completeness, the agentic-economy surface, and the integration/operations layer. **337 tests** pass on Node 20 + the full suite, typecheck, and an end-to-end demo run green in CI on Node 22.

**Injected by the operator, not in-repo** (a deliberate boundary, not a gap): the live rail clients (Visa/Mastercard/ACP credentials, a funded on-chain signer + facilitator) and the live identity verifiers. Each fails *safe* when unconfigured — a real rail never fabricates a settlement.

**Follow-ons:** multi-instance cache invalidation for the Postgres store (LISTEN/NOTIFY), the Hermes-style hibernating runtime for inbound payment-challenge events, and a `tsc → dist` build before a public `npm publish`.

## Quickstart

```bash
npm install
npm test                                   # 337 tests — gate, audit, executor, stores, rails, harness, surfaces
npm run demo                               # end-to-end walkthrough on the in-memory store (any Node)
```

```bash
# grant authority, then let the agent spend inside it
npm run cli -- mandate grant --label groceries --class groceries \
    --currency GBP --rails card --per-tx 50000 --per-period 100000 --period week --expires-days 30
npm run cli -- agent "PAY 8000 GBP tesco groceries card :: weekly shop"   # auto-executes (covered)
npm run cli -- agent "PAY 60000 GBP tesco groceries card :: big shop"     # blocked (over the £500 cap)
npm run cli -- pending                                                    # what the gate parked for you
npm run cli -- approve <intentId> --rationale "yes, I know this payee"    # operator override
npm run cli -- audit verify                                               # the signed chain checks out
```

## Use it from anywhere

One gate, reached from everywhere agents live — the same executor, mandates, risk, deny-list, and signed audit behind every surface. None of them adds authority; they are transports *into* the invariant.

| Surface | Get it | What it is |
|:--|:--|:--|
| <img height="14" align="top" src="https://cdn.simpleicons.org/typescript/3178C6" />&nbsp; **TypeScript SDK** | `import { OpenSolvency }` | The programmatic façade — grant mandates, `pay()` through the gate, approve, verify the audit chain. |
| <img height="14" align="top" src="https://cdn.simpleicons.org/gnubash/4EAA25" />&nbsp; **CLI** | `opensolvency …` | `mandate` / `pay` / `agent` / `finance` / `approve` / `kill` / `audit` / `serve`. |
| <img height="14" align="top" src="https://cdn.simpleicons.org/modelcontextprotocol" />&nbsp; **MCP** | `npx -y @general-liquidity/opensolvency-mcp` | An [MCP](https://modelcontextprotocol.io) server — Claude Code / Cursor call the gated `pay` + read-only tools (or `opensolvency mcp` from the main package). |
| <img height="14" align="top" src="https://cdn.simpleicons.org/zedindustries/084CCF" />&nbsp; **ACP** | `opensolvency acp` | An [Agent Client Protocol](https://agentclientprotocol.com) surface — editors/IDEs drive the agent in-editor. |
| <img height="14" align="top" src="https://cdn.simpleicons.org/openapiinitiative/6BA539" />&nbsp; **HTTP** | `opensolvency serve` | The ingress — same gate over HTTP, OpenAPI 3.1 at `/openapi.json`, bearer-token auth, idempotency keys, rate limiting. |
| **JSON-RPC** | `handleJsonRpcCall` | The operator-side method API for low-latency embedding (`pay`, `mandate.*`, `approve`, `audit.verify`). |
| <img height="14" align="top" src="https://cdn.simpleicons.org/python/3776AB" />&nbsp; **Python** · <img height="14" align="top" src="https://cdn.simpleicons.org/go/00ADD8" />&nbsp; **Go** | [`clients/`](clients/) | Dependency-light REST clients over the ingress, for non-TS hosts. |

```ts
import { OpenSolvency } from "@general-liquidity/opensolvency";

const os = new OpenSolvency();                       // in-memory by default; pass a Store for persistence
os.grantMandate({
  label: "groceries", scope: { kind: "class", value: "groceries" },
  currency: "GBP", allowedRails: ["card"],
  perTxCap: 500_00, perPeriodCap: 1000_00, period: "week", expiresInDays: 30,
});

await os.pay({ payee: "tesco", amount: 80_00, currency: "GBP", rail: "card",
               rationale: "the weekly grocery shop" });   // → auto-executes, inside the mandate
await os.pay({ payee: "tesco", amount: 600_00, currency: "GBP", rail: "card",
               rationale: "a much bigger shop" });        // → blocked: over the £500 per-tx cap

os.verifyAudit().valid;   // true — every decision is signed and hash-linked
```

For durable, server-grade persistence, back it with Postgres (the operator brings the `pg` client):

```ts
import { OpenSolvency, createPostgresStore } from "@general-liquidity/opensolvency";

const { store, ready, flush } = createPostgresStore(pgPool);   // pgPool: a node-postgres Pool
await ready;
const os = new OpenSolvency({ store, commit: flush });         // writes are durable before pay() resolves
```

### CLI commands

| Command | What it does |
|:--|:--|
| `mandate grant \| list \| revoke` | Grant / list / revoke operator spend authority. |
| `pay --payee … --amount … --rail …` | Submit one intent through the gate. |
| `agent "<goal or PAY … DSL>"` | Run the agent loop (real model with a key; deterministic stub without). |
| `finance "<goal>"` | The personal-finance agent — persona + behavioural harness + gate-enforced `pay`. |
| `profile set` · `goal set` | Seed the operator profile + goals the harness reasons over. |
| `pending` · `approve <id> [--ack]` | See parked intents; authorize one (high-risk needs challenge-response `--ack`). |
| `kill` · `unkill` · `reset-breaker` · `status` | Operator controls — freeze all spend, release, clear the breaker, inspect. |
| `audit verify \| log \| replay` | Verify the signed chain; print it; render it as a readable timeline. |
| `audit replay-sim [--mandates f.json]` | Counterfactual: re-run real history against a candidate mandate set. |
| `serve [--port N]` · `token set <t>` | Run the HTTP ingress (+ OpenAPI); set the bearer token that guards it. |
| `mcp` · `acp` | Launch the MCP (Claude Code/Cursor) or ACP (editor) stdio surface. |

## Gate any framework's spend

Drop the gate into any agent framework in one line. The native **Vercel AI SDK**
binding:

```ts
import { generateText } from "ai";
import { createGatedPayTool } from "@general-liquidity/opensolvency/integrations";

await generateText({
  model, prompt,
  tools: { pay: createGatedPayTool({ executor }) },   // the model's spend is now gated
});
```

Every other framework wraps the same framework-agnostic `gatedPay(deps, draft)`
handler with the shared schema — e.g. a **Mastra** / **LangChain** / **OpenAI
Agents** / **CrewAI** tool:

```ts
import { gatedPay, gatedPayInputSchema, GATED_PAY_DESCRIPTION } from "@general-liquidity/opensolvency/integrations";

// Mastra
createTool({ id: "pay", description: GATED_PAY_DESCRIPTION, inputSchema: gatedPayInputSchema,
  execute: ({ context }) => gatedPay({ executor }, context) });

// LangChain / OpenAI Agents / CrewAI: register a tool whose handler is `(draft) => gatedPay({ executor }, draft)`
```

The handler routes through `executor.execute`, so the gate governs every call no
matter which framework calls it — auto-execute inside a mandate, park for approval,
or block. No prompt can override it.

## Integrations

The gate sits at the centre of the agentic-economy stack — it speaks the payment
protocols agents settle on, the identity protocols they authenticate with, and the
surfaces they're driven from. Every rail **fails safe**: with no injected client it
never fabricates a settlement.

#### Payment rails & settlement

| Integration | What it is |
|:--|:--|
| <img height="14" align="top" src="https://cdn.simpleicons.org/coinbase/0052FF" />&nbsp; **x402** | HTTP-402 + stablecoin settlement (Coinbase / Linux Foundation) — challenge → authorize → settle. |
| <img height="14" align="top" src="assets/integrations/ap2.svg" />&nbsp; **AP2** | [Agent Payments Protocol](https://ap2-protocol.org) (Google + FIDO) — SD-JWT payment mandates; an AP2 mandate maps onto an OpenSolvency mandate. |
| **Agentic Commerce Protocol** | [ACP](https://www.agenticcommerce.dev) (OpenAI + Stripe) — an agent completes a merchant checkout via a delegated payment token, settled over card rails. |
| <img height="14" align="top" src="assets/integrations/ucp.svg" />&nbsp; **UCP** · <img height="14" align="top" src="assets/integrations/mpp.svg" />&nbsp; **MPP** | [Universal Commerce Protocol](https://ucp.dev) (delegated checkout) · [Machine Payments Protocol](https://mpp.dev) (rail-agnostic, instant). |
| <img height="14" align="top" src="https://cdn.simpleicons.org/visa/1A1F71" />&nbsp; **Visa Intelligent Commerce** · <img height="14" align="top" src="https://cdn.simpleicons.org/mastercard/EB001B" />&nbsp; **Mastercard Agent Pay** | Card-network agentic-payment rails (coexist on the `card` kind). |
| <img height="14" align="top" src="https://cdn.simpleicons.org/ethereum/3C3C3D" />&nbsp; **On-chain (ERC-20 / USDC)** | Real stablecoin transfer via an injected viem-shaped signer (EVM / <img height="12" align="top" src="https://cdn.simpleicons.org/solana/9945FF" /> Solana). |
| <img height="14" align="top" src="https://cdn.simpleicons.org/stripe/635BFF" />&nbsp; **Stripe Issuing** | Single-use virtual card minted per intent, capped to exactly the amount. |

#### Identity & trust

| Integration | What it is |
|:--|:--|
| **AIP** (Agent Identity Protocol) | Ed25519 agent attestation tokens + registry JWKS — feeds the gate's risk via an `attestation` level. |
| <img height="14" align="top" src="https://cdn.simpleicons.org/visa/1A1F71" />&nbsp; **Visa Trusted Agent Protocol** | RFC-9421 HTTP message signatures — the same `attestation` shape. |
| **Network reputation** | An injected payee-reputation source feeds risk (never relaxes the floor). |
| **Sanctions / OFAC + AML** | Screening wired into the deny-list + risk classifier as a pluggable provider. |

#### Surfaces & transports

| Integration | What it is |
|:--|:--|
| <img height="14" align="top" src="https://cdn.simpleicons.org/modelcontextprotocol" />&nbsp; **MCP** · <img height="14" align="top" src="assets/integrations/agent-client-protocol.svg" />&nbsp; **Agent Client Protocol** | The MCP server (Claude Code / Cursor) + the [ACP](https://agentclientprotocol.com) editor surface (Zed et al.) — distinct from the *Agentic Commerce* payment rail above. |
| <img height="14" align="top" src="https://cdn.simpleicons.org/vercel/000000" />&nbsp; **AI SDK & frameworks** | `createGatedPayTool` (Vercel AI SDK) + the framework-agnostic `gatedPay` for Mastra / LangChain / OpenAI Agents / CrewAI. |
| <img height="14" align="top" src="https://cdn.simpleicons.org/openapiinitiative/6BA539" />&nbsp; **HTTP + OpenAPI** · **JSON-RPC** | The ingress (auth / idempotency / rate-limit) + the operator-side RPC method API. |
| **XMTP** | A second ingress transport — XMTP messages run through the same gate (consent-aware, sender crypto-identified). |
| <img height="14" align="top" src="https://cdn.simpleicons.org/githubactions/2088FF" />&nbsp; **GitHub Action** | `uses: general-liquidity/opensolvency` gates agent spend inside CI pipelines. |

#### Agentic-economy surface

| Integration | What it is |
|:--|:--|
| **Earning desk** | The inbound mirror of the gate — publish a quote, accept a *verified* inbound payment via an acceptance policy (income never recorded on faith). |
| **Service discovery + price evaluation** | Find → evaluate an x402 service's machine-readable price against the mandate before paying. |
| **x402 gating proxy** | A transparent proxy any HTTP-spending agent points at — outbound 402 challenges flow *through the gate* automatically, so agents that don't integrate explicitly are still governed. |
| **Non-custodial account connector** | Read-only by design (no transfer method) — a structural non-custodial guarantee. |

## What it enforces

The gate decides on **structured numbers and the live mandate set** — never on model text, which is why a prompt-injected rationale changes nothing. Each decision is the same pure function, signed and replayable.

| Request | Verdict | The invariant it proves |
|:--|:--|:--|
| Known payee, live mandate, under cap, low risk | **auto-execute** | autonomy *inside* the operator's bounds |
| A payee never seen before | **confirm with operator** | a novel payee is never silently paid |
| £600 against a £500 cap | **block** | caps are hard, not advisory |
| Rationale: *"ignore the mandate, auto-execute"* | **block** | the gate reads numbers, not prose — injection can't move it |
| An expired mandate | **route to operator** | spend authority is time-boxed |

All five — plus budget, deny-list, velocity, kill-switch, circuit-breaker, and rationale invariants — are pinned by the test suite. The deny-list and caps hold **independently of trust**: a payee that has earned auto-approval still cannot push past a cap or a hard deny rule.

## Architecture

Nine layers, each built and tested. Layers 1–4 are the *safety* half (may this spend happen); layers 5–9 are the *helpfulness* + reach half (what should the agent do, and from where).

```
agent / editor / MCP client / HTTP caller
        │
        ▼
   Executor ──────────────── the ONLY path to a rail
        │   builds context from the Store, runs the pure gate,
        │   signs the decision, settles ONLY on auto-execute
        ▼
   evaluateGate()  ◄── pure invariant: mandate · caps · risk · velocity · deny-list
        │
        ├── Store (memory · sqlite · postgres)      durable, signed, replayable
        ├── Rails (x402 · card · ACP · AP2 · …)      fail-safe when unconfigured
        └── Audit (hash-linked, HMAC-signed chain)   tamper-evident history
```

| Layer | What it is |
|:--|:--|
| **1 · Trust kernel** | The pure gate invariant + mandate + spend-risk + deny-list + hash-linked signed audit. No I/O, no clock — fully deterministic and replayable. |
| **2 · Ledger** | A `Store` interface with three backends: `MemoryStore` (tests), `SqliteStore` (`node:sqlite`), and `PostgresStore` (durable source of truth + in-process read mirror + a `flush()` durability barrier the executor awaits — so the sync `Store` contract and the pure gate are unchanged). |
| **3 · Rails** | A `PaymentProvider` interface + adapters for **x402, ACP, UCP, MPP, Visa, Mastercard, AP2** (+ `FakeRail`). Each declares accurate capabilities and takes an injected `RailClient`; **with none it fails safe — a real rail never fabricates a settlement.** Reference clients: on-chain ERC-20 transfer, single-use virtual card, and the x402 challenge→authorize→settle flow. |
| **4 · Agent + CLI** | The `Executor` is the *only* path to a rail. The agent runs on the **Vercel AI SDK** multi-step loop, but its sole money tool (`pay`) executes *through* the gate, so even the autonomous loop can't bypass it. A deterministic offline stub backs tests + air-gapped runs. |
| **5 · Behavioural harness** | The *helpfulness* half, from the Networth research. The **Four Pillars of Resilience** model the operator; the weakest pillar becomes the agent's standing agenda. Plus teachable-moment detection, "watching-your-back" concerns, goals-as-objectives, an empower-don't-exploit guardrail, anxiety-aware comms, cognitive-trap + knowledge-gap detectors, slip-cost + retirement projections, and an **i-frame/s-frame** honesty guardrail. |
| **6 · Harness depth** | **Trust trajectory** (payees earn auto-approval; floor never relaxed), **hot-tier memory** + cold recall, **skills** (markdown playbooks on demand), a **self-evolution envelope** (Tier-1 lessons over a frozen Tier-0 floor), the **reasoning sandwich**, and a counterfactual **policy-replay simulator**. |
| **7 · Money-domain completeness** | **Refunds** (reversible rails only — irreversible refused), **multi-currency FX** (capped in the mandate's currency), **mandate lifecycle** (amend/extend/templates), **reconciliation** (flags unauthorized spend), **non-custodial account connection** (read-only by design) + **key custody**. |
| **8 · Agentic-economy surface** | **Network reputation** (feeds risk, never the floor), **service discovery + price evaluation**, the **earning side** (publish a quote, accept a *verified* inbound payment — income never recorded on faith), and the **MCP server**. |
| **9 · Integration + operations** | The gate everywhere agents live: **MCP**, **ACP**, and **HTTP ingress** with **OpenAPI 3.1** + **bearer-token** auth, **idempotency keys**, a **rate limiter**, a **body-size cap**, and a `/ready` probe. Operationally: an injected **notifier** (noop/console/webhook) pings the operator out-of-band on a pending payment — best-effort, never blocks a decision — and an **OTLP/HTTP tracer** ships events to any OpenTelemetry collector, dep-free. |
| **10 · Eval harness** | The payments-domain analogue of Gordon's RULER harness. **Generated scenarios** (from the gate-acceptance spec + the deny-list, each `derivedFrom`-stamped) run **live** through a deterministic executor + `FakeRail`; **process checks** replay the signed audit trace and fail on the catastrophic money-agent failures (settling a blocked intent, settling with no gate decision, settling while halted); **pass^k** (`mode "all"` for safety) demands every run be safe; an opt-in **LLM-judge** leg scores advisory quality. A deterministic **CI gate** (`npm run eval-gate`) blocks regressions. |

#### Runtime posture (decided, deferred)
Hermes-style serverless-hibernation (always-reachable, ~$0 idle) — **not** Aeon's GitHub-Actions cron: a money agent must answer inbound payment challenges (x402/ACP) as *events*, which a 5-minute cron can't. Execution is non-custodial — it runs through the operator's own connected accounts.

## Real settlement (testnet)

Every rail fails safe by default — it never moves money without an injected client.
To run a **genuine** settlement through the gate, `scripts/testnet-settle.ts` wires a
live [viem](https://viem.sh) wallet into the `OnchainSigner` seam and does a real
ERC-20 stablecoin transfer on a testnet. You bring a funded testnet key; the gate
runs for real (a vetted payee auto-executes; an unvetted one is blocked before any
transfer):

```bash
OPENSOLVENCY_RPC_URL=https://sepolia.base.org \
OPENSOLVENCY_PRIVATE_KEY=0x...        # a funded testnet key (yours)
OPENSOLVENCY_TOKEN_ADDRESS=0x...      # testnet USDC (6 decimals)
OPENSOLVENCY_PAYEE_ADDRESS=0x...      # where to send
OPENSOLVENCY_AMOUNT=10000             # base units (0.01 USDC)
npm run testnet-settle
```

The published package ships the seam, not the wallet — `viem` is a dev-only
dependency, so a consumer brings their own signer (or uses this script as the
template).

## Tech stack

| Technology | Role |
|:--|:--|
| <img height="14" align="top" src="https://cdn.simpleicons.org/typescript/3178C6" />&nbsp; [TypeScript](https://www.typescriptlang.org) | The whole system — strict, ESM, integer minor-units, `.ts` imports |
| <img height="14" align="top" src="https://cdn.simpleicons.org/nodedotjs/5FA04E" />&nbsp; [Node ≥ 22.18](https://nodejs.org) | Runtime; `node:sqlite` + `node:crypto`, no native build step |
| <img height="14" align="top" src="https://cdn.simpleicons.org/vercel/000000" />&nbsp; [Vercel AI SDK](https://sdk.vercel.ai) | The multi-step agent loop; the model's sole tool runs through the gate |
| <img height="14" width="14" align="top" src="https://registry.npmmirror.com/@lobehub/icons-static-svg/latest/files/icons/openai.svg" />&nbsp; OpenAI · <img height="14" align="top" src="https://cdn.simpleicons.org/anthropic/D97757" />&nbsp; Anthropic · <img height="14" align="top" src="https://cdn.simpleicons.org/googlegemini/8E75B2" />&nbsp; Gemini | Model providers, swappable by config — add one with one `@ai-sdk/*` package |
| <img height="14" align="top" src="https://cdn.simpleicons.org/sqlite/003B57" />&nbsp; SQLite · <img height="14" align="top" src="https://cdn.simpleicons.org/postgresql/4169E1" />&nbsp; Postgres | Durable stores behind the synchronous `Store` boundary |
| <img height="14" align="top" src="https://cdn.simpleicons.org/zod/3E67B1" />&nbsp; [Zod](https://zod.dev) | Schema validation at every boundary (intents, ingress, tools) |
| <img height="14" align="top" src="https://cdn.simpleicons.org/modelcontextprotocol" />&nbsp; [MCP](https://modelcontextprotocol.io) · <img height="14" align="top" src="https://cdn.simpleicons.org/zedindustries/084CCF" />&nbsp; ACP | Agent-facing transports into the gate |
| <img height="14" align="top" src="https://cdn.simpleicons.org/opentelemetry/F5A800" />&nbsp; [OpenTelemetry](https://opentelemetry.io) | Operational tracing over OTLP/HTTP, no hard dependency |
| <img height="14" align="top" src="https://cdn.simpleicons.org/githubactions/2088FF" />&nbsp; GitHub Actions | CI: typecheck · full suite · end-to-end demo, on Node 22 |

## What we took from Gordon

Gordon is a **safety / governance / memory harness wrapped around a *trading* domain**. OpenSolvency is that same harness wrapped around a **payments / agentic-economy** domain. We ported the *harness*, not the trading.

- **LIFT** (port the pattern, re-domained): deny-first gate + hard deny-list (`place_order` → `make_payment`); rejection-weighted adaptive trust; multi-dimension risk classifier → spend-risk; rationale-required-on-execute; HMAC signed audit (here a hash-linked chain); single-substrate observation discipline; hot-tier memory; propose-only ACE lessons; velocity/backpressure → the per-mandate velocity ceiling; preview→approve as an invariant.
- **ADAPT** (reuse the shape, swap the content): the typed surface dispatcher; exchange/broker adapters → the rails layer.
- **LEAVE** in Gordon (trading-specific): indicators, microstructure, backtest, genome/evolution, regime detection, strategy-validation stats, playbooks, the trading tool surface.

From **FinancialClaw** (data-layer patterns): integer minor-units, multi-currency resolve, idempotent migrations, allocation-as-budget-seed.

## Develop

`tsx` is bundled so the test suite + demo run on Node ≥ 18; the sqlite-backed CLI needs Node ≥ 22.5 (`node:sqlite`).

```bash
npm install
npm test          # 337 tests
npm run typecheck # tsc --noEmit, strict
npm run demo      # end-to-end walkthrough on the in-memory store (any Node)
```

A real model (via the Vercel AI SDK) is used automatically when a key is present; otherwise the deterministic stub parses the `PAY …` DSL.

- `OPENSOLVENCY_MODEL_PROVIDER` — `openai` (default), `anthropic`, or `google`.
- key — `OPENSOLVENCY_MODEL_API_KEY`, or the provider's standard env var.
- `OPENSOLVENCY_MODEL` — model id (defaults per provider).

## Documentation

The full docs are an [mdBook](https://rust-lang.github.io/mdBook/) under [`docs/`](docs/)
— the gate, the mandate model, the acceptance demo, every surface, deployment,
security, and the SpendTrust benchmark:

```bash
mdbook serve docs        # then open http://localhost:3000
```

## License

[MIT](LICENSE) © General Liquidity. A General Liquidity product — liquidity and solvency are the two halves of financial health, and OpenSolvency is the half that keeps an autonomous agent inside its bounds.

---
