# AgentWorth completeness audit — 2026-06-27

Scope: validate the 18-item Claude Code backlog against current `main`, then
trace package exports, runtime composition, persistence, identity, and settlement
paths. Findings were checked against callers and tests rather than TODO markers.

## Resolved in this pass

- Audit hashes now survive SQLite/Postgres/JSON round-trips with omitted
  `undefined` fields.
- The executor uses cross-decimal FX conversion for live cap/budget decisions.
- Production gate entries capture known payees, period spend, FX rates, and the
  full verdict; `decisionRecordFromAuditEntry` makes them directly replayable.
- `rails`, `finance`, `evals`, `earn`, and `proxy` are published package subpaths.
  Real rail-client constructors are exported from `/rails`.
- SDK callers can inject FX, reputation, notifier, and tracer dependencies.
  CLI/MCP runtimes support webhook and OTLP environment configuration.
- Fake rails are explicit simulation mode. Unconfigured SDK/CLI/MCP runtimes now
  fail closed instead of reporting a phantom settlement.
- Postgres retains failed writes for retry and rejects conflicting audit sequence
  rows instead of hiding a fork.
- Direct ERC-20 settlement has its own `direct-onchain` provider instead of being
  mislabeled as x402.
- MCP and HTTP transports accept trusted attestation resolvers; callers cannot
  self-assert attestation in payment arguments.
- Student-finance, reconciliation, proactive-moment, earning, and proxy
  primitives are reachable through public package exports.

## Incorrect or stale reported findings

- There is no silent `RailKind` overwrite in current code. Providers are keyed by
  protocol ID, ambiguous kinds require an explicit route, and unresolved
  ambiguity fails closed.
- MCP's default `attestation: "none"` is intentional for an unauthenticated
  caller. Accepting a caller-provided attestation would be a security regression;
  trusted transport verification is the correct integration point.
- The June 25 rail audit predates fixes already present for Visa TAP, the static
  identity verifier, UCP capability posture, and on-chain labeling.

## Remaining work, in priority order

1. **x402 V2 correctness.** The client/proxy is explicitly V1-shaped. Current x402
   uses `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`, CAIP-2
   network IDs, and V2 payloads. The proxy also settles through the executor
   before retrying the origin, while the origin is supposed to verify and settle
   the authorization. This needs a protocol-level redesign, not a header rename.
   Sources: <https://docs.x402.org/core-concepts/http-402> and
   <https://docs.x402.org/guides/migration-v1-to-v2>.
2. **Behavioural eval execution.** `runEvalSuite` runs six deterministic
   gate/process scenarios. Judge adapters and rubrics exist, but no agent answer
   is passed through a judge, and `k > 1` repeats a deterministic path. Add an
   injected answer producer/live sandbox, behavioural scenarios, judge threshold,
   and genuine repeated model runs.
3. **Audit-key rotation.** `keyCustody.ts` is not connected to `AuditLog`;
   `AuditEntry` has no key version. Add per-entry key IDs and keyring verification,
   then remove the older duplicate `keys.ts`.
4. **Provider-bound receipts/refunds.** A refund resolves the current provider for
   a rail kind, not necessarily the provider that issued the receipt. Persist the
   provider ID with each receipt and resolve refunds by that ID.
5. **Currency metadata.** ISO exponents cover fiat, but token symbols such as USDC
   need injected decimals. The currency-agnostic irreversible-unknown floor is
   also operational policy and should be configurable.
6. **CLI real-rail composition.** Real rail constructors are now public, but the
   bundled CLI/MCP runtime only supports an empty fail-closed registry or explicit
   simulation. Add a validated operator configuration/plugin mechanism for live
   clients.
7. **Runtime integrations.** Add an event source/hibernating scheduler for
   proactive moments and a configured service catalog for the bundled finance
   CLI. `discover_services` intentionally returns an empty list when none is
   supplied.
8. **Stripe Issuing.** The generic `CardIssuer` seam is functional; a built-in
   Stripe adapter remains a feature, accurately documented as seam-only.
9. **Documentation cleanup.** Replace the remaining 86 bare `OS` shorthand
   references in comments/docs and finish updating stale conformance prose.

## Verification

- `bun test test`: 616 passing, 0 failing.
- `npx tsc --noEmit -p tsconfig.json`: clean.
- `npx tsc -p tsconfig.build.json`: clean.
- Built self-referencing imports succeed for `/rails`, `/finance`, `/evals`,
  `/earn`, and `/proxy`.
- Biome could not start in this Linux shell because the checked-out
  `node_modules` contains Windows-native binaries.
