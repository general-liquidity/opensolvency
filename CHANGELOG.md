# Changelog

All notable changes to OpenSolvency are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to adhere to
semantic versioning once it reaches 1.0.

## [Unreleased]

### Added
- **Verifiable Agency — agent disclosure schema** (`src/disclosure/`, exported at
  `@general-liquidity/opensolvency/disclosure`). The vendor-neutral core of a
  disclosure protocol for agent-to-agent commerce: a versioned, zod-validated
  `AgentDisclosure` covering all seven field groups (system-prompt fingerprint,
  operating constitution + hard constraints with an `enforced` flag, tool inventory
  + permission boundaries, capital/risk envelope, operator identity + deniability,
  deployment-history summary anchored to the audit chain, red-team attestation), plus
  a `SignedDisclosure` envelope pinned to **ed25519** (asymmetric, so a counterparty
  verifies without a shared secret). No OpenSolvency imports — designed to lift into a
  standalone `agent-disclosure` repo; the OpenSolvency field builders (next) populate
  it from the live gate / mandates / audit / SpendTrust. The reference implementation
  of the "pluggable behavioural-trust layer" ERC-8004 et al. defer.
  - **Attestation** (`attestation.ts`): ed25519 sign/verify + deterministic
    canonicalization + freshness + the agentId↔key binding (a disclosure must be
    signed by the key it claims as its identity).
  - **Verification** (`verify.ts`): a counterparty `VerificationPolicy` and
    `evaluateDisclosure → {transact | refuse, reasons}` — enforced-constitution,
    required hard-constraints, min red-team grade, non-custodial, attestation level,
    deployment-history, and audit-anchor checks. Deterministic and cheap.
  - **Builders** (`builders.ts`, OpenSolvency-specific): `buildAndSignDisclosure`
    populates every field from the live deny-list, gate config, granted mandates,
    signed audit-chain head, and a SpendTrust run — proven end-to-end (build → sign
    → verify → policy → transact/refuse, with tamper / forged-identity / staleness /
    grade-threshold all caught).
  - **Verification handshake** (`handshake.ts`): a live ed25519 challenge-response —
    the verifier issues a nonce, the agent signs it bound to its current audit-chain
    head — proving live key possession and history currency. Closes the identity-
    replay gap a static disclosure can't (replay, wrong-key, and stale responses all
    rejected). Plus agent-key persistence (`loadOrCreateAgentKey`) so the signing
    identity is stable across restarts.
  - **CLI**: `opensolvency disclose [--out f]` emits a signed disclosure;
    `verify-disclosure <file> [--require-grade B] [--require-enforced] …]` runs a
    counterparty policy and exits non-zero on refuse.

## [0.1.1] — 2026-06-24

The full P1/P2 ecosystem build-out that landed after the `0.1.0` publish, plus a
complete integrations catalog in the README.

### Added
- **New package subpath exports**: `@general-liquidity/opensolvency/integrations`
  (framework adapters — `gatedPay` + AI SDK `createGatedPayTool`) and
  `@general-liquidity/opensolvency/gate` (the portable, node-free gate kernel).
- **SpendTrust benchmark**, **JSON-RPC interface**, **multi-tenant isolation**,
  **audit-log export + standalone verifier**, **versioned config schema**,
  **property/fuzz tests** on the gate, **Python + Go REST clients**, **reference
  example agents**, a **CI spend-gating GitHub Action**, a **Biome lint gate**, and
  an **mdBook docs site** — see the entries below.
- **README integrations catalog** — every payment rail (x402, AP2, ACP, UCP, MPP,
  Visa, Mastercard), settlement client (on-chain/USDC, Stripe Issuing, x402
  facilitator), identity protocol (AIP, Visa Trusted Agent Protocol), transport
  (HTTP, JSON-RPC, XMTP, MCP, ACP), and agentic-economy surface (earning desk,
  service discovery, x402 gating proxy, non-custodial connector) is now listed.

### Changed
- The `@general-liquidity/opensolvency-mcp` wrapper is unchanged in behaviour
  (the MCP surface is intentionally the gated `pay` + read-only tools); its version
  tracks the main package at `0.1.1`.

## [0.1.0] — 2026-06-24

First named release (graduated from the `opensolvency` placeholder). The kernel,
gate, audit chain, rails, agent loop, and the Networth-derived behavioural harness
were built across the preceding milestones; this release adds the production
hardening and integration surfaces.

### Added
- **Documentation site** (`docs/`) — an mdBook covering the gate, mandates, the
  acceptance demo, every surface, framework integration, deployment, security, and
  the SpendTrust benchmark. Built in CI (`mdbook build docs`); `mdbook serve docs`
  locally.
- **Language clients** (`clients/`) — dependency-light REST clients over the HTTP
  ingress for non-TypeScript hosts: **Python** (stdlib only) and **Go** (stdlib only),
  each with `pay` / `status` / `ready`, bearer-token + idempotency-key support, and a
  `blocked` outcome treated as a normal result. They add no authority — every payment
  still runs through the gate. (The TS SDK remains the in-process full-feature surface.)
- **Biome lint quality gate** — `biome.json` tuned to the project's style; `npm run
  lint` runs in CI as a blocking step (fixed the handful it flagged). `format` /
  `format:check` scripts are available but formatting is not mass-applied (avoiding
  churn); lint is the enforced gate.
- **Reference example agents** (`examples/`) — a key-free `shopping-agent.ts`
  demonstrating all four gate verdicts (auto-execute / park / block / injection-
  resistance), and an `ai-sdk-agent.ts` wiring `createGatedPayTool` into a real
  Vercel AI SDK agent. `npm run example:shopping`; the shopping flow is test-pinned.
- **CI spend-gating GitHub Action** (`action.yml`) — `uses: general-liquidity/
  opensolvency` routes a pipeline payment through the gate and fails the job unless
  it's authorized (e.g. an agent buying compute in CI can't spend outside mandates).
- **SpendTrust benchmark** (`src/benchmark/`) — "can your agent be trusted to
  spend?", the OpenSolvency analog to SharpeBench. An agent submits its decision log;
  `scoreSpendTrust` / `rankSpendTrust` grade it (A–F) on gate-respect, honest
  rationales, no doom-loops, and backing off on pending — deterministic and
  explainable. Retrying a blocked payment or an injected rationale **hard-fails**
  regardless of settled count (raw throughput is never the rank key). Ships a
  reference field (trustworthy / doom-looper / injector); CLI `benchmark`; SDK-exported.
- **JSON-RPC interface**, **multi-tenant isolation**, **versioned config** (above).
- **Audit-log export + standalone verifier** — `exportAuditChain` dumps the signed
  hash-linked chain to a portable file (jsonl/json); `verifyAuditExport(dump, key)`
  re-verifies it standalone (no store/executor), reusing the exact `AuditLog.verify`
  logic. CLI: `audit export` / `audit verify-export <file>`. (HMAC-symmetric — proves
  integrity to a key holder; asymmetric public verifiability is a noted future step.)
- **Versioned config schema + migration** — `src/config/schema.ts`: a zod-validated
  operator config carrying an explicit `version`, with `migrateConfig` forward-
  migrating older shapes (a missing version = pre-versioning v0, filled with
  defaults) before validation. Mirrors the mandate-lifecycle versioning discipline.
- **Framework integration adapters** (`@general-liquidity/opensolvency/integrations`)
  — a framework-agnostic `gatedPay` handler (+ shared name/description/zod schema)
  and a native Vercel AI SDK `createGatedPayTool`, so any agent framework (AI SDK,
  Mastra, LangChain, OpenAI Agents, CrewAI) gates its spend in one line.
- **Portable gate kernel** (`@general-liquidity/opensolvency/gate`) — `evaluateGate`
  plus its pure inputs with **zero `node:` dependencies**, so the same invariant runs
  in a browser / edge worker / other-language host. A test asserts the whole import
  graph stays node-free (chosen over a WASM port to keep one source of truth).
- **Property/fuzz tests on `evaluateGate`** — 2000 seeded random (intent, mandate-set)
  scenarios asserting the load-bearing invariants (deny-match ⇒ block; auto-execute ⇒
  a live covering mandate within its per-tx cap; no cover ⇒ never auto-execute).
- **Standalone MCP package** — `@general-liquidity/opensolvency-mcp`, an npx-able
  MCP server (`npx -y @general-liquidity/opensolvency-mcp`) so editors configure it
  like any other MCP server. It delegates to the main package's new `./mcp` subpath
  export (`startOpenSolvencyMcp`), which the bundled `opensolvency mcp` command now
  shares — one gated surface, two entry points. The package is scoped
  `@general-liquidity/opensolvency` (matching SharpeBench), publishable with
  `publishConfig.access: public`.
- **Real on-chain settlement path (testnet)** — `scripts/testnet-settle.ts` takes
  the system past the fail-safe stubs: a genuine ERC-20 stablecoin transfer (e.g.
  testnet USDC) executed by the same executor + gate, via a live `viem` wallet
  adapted to the repo's `OnchainSigner` seam (`viem` is a dev-only dep; the shipped
  package keeps the seam, not the wallet). Needs an operator-supplied funded testnet
  key. The gate runs for real — a unit test proves a *vetted* payee auto-executes
  (tx hash flows back as the receipt) while an *unvetted* one is blocked by the
  deny-list with the signer never called (money never moves).
- **Deployable runtime** — a multi-stage `Dockerfile` (non-root, `node:sqlite`,
  `/ready` healthcheck), `docker-compose.yml`, and `DEPLOY.md`. The `serve` command
  gained `--host` and now **fails closed**: binding a non-loopback interface without
  an ingress token is refused (the gate still governs spend, but the transport is
  never exposed unauthenticated). The token can be set via `OPENSOLVENCY_INGRESS_TOKEN`
  (ergonomic for containers) as well as `token set`.
- **Publishable on npm** — the `opensolvency` name is available; the build ships a
  clean ~168 kB tarball (dist + `.d.ts` + LICENSE/CHANGELOG/README, no dead maps).
- **Eval harness** (`src/evals/`) — the payments-domain analogue of Gordon's RULER
  harness. **Generated scenarios** (from the gate-acceptance spec + the deny-list,
  each `derivedFrom`-stamped) run **live** through a deterministic executor +
  `FakeRail`; **process checks** (`checkTrajectory`) replay the signed audit trace
  and fail on the catastrophic failures — settling a gate-blocked intent, settling
  with no gate decision, settling while halted; **pass^k** (`computePassK`,
  `mode "all"` for safety) demands every run be safe; an opt-in **LLM-judge** leg
  (`judge.ts`, with a deterministic stub) scores advisory quality. A deterministic
  **CI gate** (`npm run eval-gate`, a third CI job) blocks any regression, and
  `opensolvency evals` runs it locally.
- **Payments / HTTP hardening** — **idempotency keys** (`Idempotency-Key` header:
  a retried `POST /payment-intent` replays the first result and the gate runs once,
  so a network retry can't settle twice), a per-IP **rate limiter** (fixed-window,
  `429` + `Retry-After`), a **request body-size cap** (`413`), and a **`/ready`**
  readiness probe (distinct from `/health`). All documented in the OpenAPI doc.
- **Editor integration (ACP)** — an Agent Client Protocol stdio surface
  (`src/acp/`) so editors/IDEs can drive the gate-enforced finance agent in-editor,
  alongside the existing MCP server (Claude Code / Cursor) and HTTP ingress.
- **OpenAPI 3.1 document** served at `GET /openapi.json` describing the ingress
  surface for machine discovery.
- **Ingress authentication** — an operator-set bearer token gates the HTTP
  transport (`/health` always open); the surface stays open on loopback when no
  token is configured.
- **Operator notifications** — an injected `Notifier` seam (no-op default, console
  and webhook implementations) pings the operator out-of-band when a payment is
  routed to confirmation, so the pending queue need not be polled. Best-effort:
  it can never block or alter a gate decision.
- **OTLP tracer** — a real `Tracer` that ships executor lifecycle events to an
  OpenTelemetry collector over OTLP/HTTP (JSON), with no hard `@opentelemetry/*`
  dependency.
- **Postgres store** (`createPostgresStore`, exported from the SDK) — durable,
  server-grade persistence. Postgres is the source of truth; an in-process mirror
  serves the synchronous `Store` reads (so the gate stays pure and nothing else
  changes), and writes are persisted through a serialized queue with a `flush()`
  barrier the executor awaits (the new `commit` dep) so a payment's writes are
  durable before `execute()`/`approve()` resolves — no write-behind data-loss risk.
  The `pg` client is injected (operator brings `pg.Pool`).
- **Postgres multi-instance read coherence** — an optional `PgNotificationListener`
  seam (Postgres LISTEN/NOTIFY): a store publishes its writes via `pg_notify` and
  refreshes its read mirror when another instance changes a mandate / intent /
  receipt / meta row, so secondary instances stay current without re-reading the
  whole table. Eventual (NOTIFY-latency) consistency; the signed audit chain stays
  single-writer (hash-linked), so writes route through one instance.
- Packaging: `LICENSE` (MIT), this changelog, and a publishable package manifest.
- **Publishable build** — `npm run build` compiles `src` → `dist` (ESM + `.d.ts`),
  rewriting `.ts` import specifiers to `.js` (TS `rewriteRelativeImportExtensions`).
  `bin`/`main`/`types`/`exports` point at `dist`, `prepublishOnly` runs the build,
  and the package is no longer `private` — ready for `npm publish` once the name is
  claimed. CI now builds the dist on every run.
