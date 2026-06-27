# Security & compliance posture

AgentWorth is a governance plane for agentic spend; its security model *is* the
product. This document maps the technical controls to the kinds of assurances a
SOC 2 / enterprise review asks for. SOC 2 itself is an audited *process* (a report
issued by a third party over a period); this is the **engineering posture** that
process would attest to — plus the explicit gaps.

## Core invariants

- **Deny-first gate.** A payment can only auto-execute inside a live, operator-granted
  mandate, under its caps, below risk/velocity thresholds, and clear of the deny-list.
  The gate is a **pure function over structured data** — prompt-injected text cannot
  move it (verified by the eval suite + 2000-scenario fuzz).
- **Single money path.** The executor is the only route to a rail; no surface
  (CLI / SDK / MCP / ACP / HTTP) adds authority — each is a transport into the gate.
- **Tamper-evident audit.** Every decision is recorded to a hash-linked, HMAC-signed
  chain; `verifyAuditExport` re-verifies an exported chain standalone.
- **Kill switch + circuit breaker.** Operator-only flags freeze settlement; the agent
  cannot write them.

## Access control & isolation

- **Non-custodial.** Execution runs through the operator's own connected accounts /
  injected rail clients — AgentWorth never holds funds. This removes the single
  largest class of custodial risk.
- **Operator-only controls.** Approve / kill / refund / amend are never exposed to
  agents (the MCP/HTTP surfaces expose a gated `pay` + read-only tools only).
- **Multi-tenant isolation.** `createMultiTenantStore` gives each operator a
  structurally separate store + audit chain in a shared process — no cross-tenant
  data path.
- **Transport auth.** The HTTP ingress requires a bearer token to bind a public
  interface (fails closed), with rate limiting + body-size caps + idempotency keys.

## Key management

- **Pluggable key custody** (`core/keyCustody.ts`): the audit-signing key comes from
  an injected `KeyProvider` (env / KMS / Vault), with **rotation** and versioned
  re-verification. Keys are not stored in the database.

## Screening & monitoring

- **Sanctions / AML** (`src/compliance/`): OFAC-style screening wired into the
  deny-list + risk classifier as a pluggable provider seam.
- **Network reputation** feeds risk (never relaxes the floor).
- **Continuous eval gate** (`src/evals/`): generated adversarial scenarios + process
  checks block regressions in CI.

## Data handling

- Integer minor-units; no PII required by the core gate. The behavioural-harness
  profile is operator-supplied and stored in the operator's own store.
- Audit export supports archival + independent verification.

## Known gaps (honest)

- **Third-party security audit** — not yet performed (the load-bearing external step).
- **Audit signatures are HMAC (symmetric)** — integrity is provable to a key holder,
  not publicly; asymmetric (Ed25519) signing for public verifiability is planned.
- **SOC 2 / pen-test / insurance** — process items for a hosted offering, not yet
  undertaken.
- **Live rail credentials** are operator-injected; the bundled clients fail safe
  (never fabricate a settlement) but live-rail webhook reconciliation is not wired.

## Reporting a vulnerability

Email the maintainers (see `package.json` author) rather than opening a public issue
for anything exploitable.
