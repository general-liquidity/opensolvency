# AgentWorth Rail-Conformance Audit — adapters vs upstream protocol specs

**Date:** 2026-06-25
**Scope:** do AgentWorth's payment/identity **rail adapters** faithfully implement the upstream
specs they integrate? Companion to the ADP audits in the sibling repo
(`agent-disclosure-protocol/docs/audits/`): `2026-06-25-integration-conformance.md` (integration
lens, incl. the ADP-side ERC-8004 finding) and `2026-06-25-sota-design-audit.md` (ADP's own
protocol design).
**Method:** parallel agents pulling each upstream org's repos/specs and diffing against our
adapter code.
**Status:** findings only — no code changes made. Severities: **CRITICAL** (fictional / won't work
against a real counterparty), **INTEGRITY** (compiles and "works" but a claimed security property
isn't enforced), **CORRECTNESS** (wrong/inverted behavior), **COSMETIC** (naming/labelling).

> Superseded in part on 2026-06-27. Visa TAP verification, the dev-verifier
> downgrade, UCP conservatism, provider-ID routing, and direct-onchain labeling
> are fixed in current code. The x402 V2 migration and Stripe adapter remain open.

---

## Verdict table

| Protocol / adapter | File(s) | Verdict | Severity |
|---|---|---|---|
| AP2 content schemas | `src/rails/ap2/ap2Rail.ts`, `ap2/mandate.ts` | Field-exact against upstream JSON Schemas — **strongest adapter we ship** | ✅ conformant |
| MCP server | `src/mcp/server.ts`, `agentworth-mcp/` | Real `@modelcontextprotocol/sdk@^1.29.0`, conformant | ✅ conformant |
| Agent Client Protocol (Zed) | `src/acp/` | Conformant | ✅ conformant |
| Visa Trusted Agent Protocol | `src/identity/verifier.ts` | Claims RFC 9421; ships only string-map `staticIdentityVerifier` | **INTEGRITY** |
| x402 | `src/rails/x402.ts`, `clients/x402Client.ts`, `proxy/x402Proxy.ts` | V1-shaped but wire-incomplete | CORRECTNESS |
| UCP | `src/rails/ucp.ts` | Inverted comment + wrong reversibility flag → gate risk | CORRECTNESS (gate-affecting) |
| onchainClient | `src/rails/clients/onchainClient.ts` | Mislabeled vs what it does | COSMETIC→CORRECTNESS |
| Stripe Issuing | (surface only) | No real adapter behind the surface | CRITICAL (absent) |

---

## Detail

### Visa Trusted Agent Protocol — self-assertable identity (INTEGRITY)

`identity/verifier.ts` advertises RFC 9421 (HTTP Message Signatures) for Visa TAP, but the shipped
`staticIdentityVerifier` is a **string map** — it matches an asserted identity against a table and
returns "verified" **without performing any signature verification**. The claimed cryptographic
property is not enforced: a counterparty can assert any identity in the map and pass. Because the
spend gate treats the verifier's "verified" as trustworthy, this is an **integrity** bug, the most
dangerous class in this audit.

**Fix:** implement real RFC 9421 verification (signature base over the covered components, `keyid`
resolution, `created`/`expires` window) — or remove the RFC 9421 claim and downgrade the gate's
trust in this path until it's real.

### x402 — wire-incomplete (CORRECTNESS)

The adapter is shaped like x402 V1 but is **missing required fields** relative to the live x402
header/payload format, so it will not round-trip against a real x402 facilitator/origin. Complete
the header + payload to the current x402 schema (cross-check against the upstream `x402` repo;
note V1→V2 has a published migration guide).

### UCP — inverted comment + wrong reversibility (CORRECTNESS, gate-affecting)

In `rails/ucp.ts` a capability comment is **inverted** relative to the behavior, and the
**reversibility flag is wrong**. This is not cosmetic: the spend gate reads reversibility to decide
how much scrutiny an action needs, so a reversible action mis-flagged as irreversible (or vice
versa) **changes the gate decision**. Correct the flag and the comment together.

### onchainClient — mislabeled (COSMETIC→CORRECTNESS)

`rails/clients/onchainClient.ts` does not do what its name/docs imply. Re-label to match actual
behavior (or implement the behavior the name claims). Low risk on its own, but mislabeled clients
in a money path invite mis-use.

### Stripe Issuing — absent (CRITICAL if surfaced)

There is a Stripe Issuing surface with **no real adapter** behind it. Either build the adapter or
remove the surface claim so callers don't believe a virtual-card path exists when it doesn't.

---

## Cross-cutting

### `RailKind` "checkout" routing collision

Multiple distinct rails map to the same `RailKind` value `"checkout"`, so the router cannot
disambiguate them. Introduce distinct kinds (or a secondary discriminator) so routing is
deterministic.

### Two-ACP naming trap

`src/rails/acp.ts` = **Agentic Commerce Protocol** (OpenAI/Stripe). `src/acp/` = **Agent Client
Protocol** (Zed). Same acronym, unrelated protocols, adjacent paths — a latent foot-gun for any
future contributor. Rename one (e.g. `src/rails/agentic-commerce/`) to break the collision.

---

## Priority order

1. **Visa TAP integrity gate** (INTEGRITY) — implement real RFC 9421 verification or drop the claim.
2. **x402 header/payload completion** (CORRECTNESS).
3. **UCP reversibility/comment fix** (gate-affecting; small change).
4. **RailKind "checkout" disambiguation** + **two-ACP rename** (cheap; prevents mis-wiring).
5. **Stripe Issuing** — build the adapter or remove the surface.
6. **onchainClient** re-label.

What's conformant and worth preserving as the reference pattern: **AP2** (field-exact), **MCP**,
and **ACP-Zed**. Model new adapters on the AP2 rail's fidelity.

> The ADP-side ERC-8004 finding (fictional `agentOf` ABI + the Validation-Registry positioning
> reframe) is documented in `agent-disclosure-protocol/docs/audits/2026-06-25-integration-conformance.md`.
