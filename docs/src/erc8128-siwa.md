# On-chain agent identity — ERC-8128 & SIWA

AgentWorth never issues identity. It **consumes** an identity verdict as a risk
input to the gate: the `Attestation` level (`none | signed | registry_attested`)
feeds the gate's risk and **never relaxes the floor** (caps and the deny-list are
never overridable by a strong attestation). These two verifiers add on-chain,
Ethereum-wallet-backed identity to the existing `IdentityVerifier` family alongside
`visaTapVerifier` (RFC 9421 / Ed25519) and the dev-only `staticIdentityVerifier`.

Both verifiers do **real cryptography** (secp256k1 EIP-191 recover + keccak-256) via
a **dynamic import** of the optional `@noble/curves` + `@noble/hashes` dependencies —
the core gate pulls no crypto unless an on-chain request is actually verified.

## ERC-8128 — Ethereum-wallet-signed HTTP requests

ERC-8128 reuses the RFC 9421 (HTTP Message Signatures) signature base, but the
signing scheme is **EIP-191 / `personal_sign`** over that base, recovered to an
secp256k1 address. There is **no `alg` parameter**: the verifier branches on the
`keyid` prefix and the expected signer **is** the keyid address.

- **keyid:** `erc8128:<chainId>:<0xaddress>` (regex `^erc8128:(\d+):(0x[a-fA-F0-9]{40})$`,
  address case-insensitive).
- **Signing scheme:** `H = keccak256("\x19Ethereum Signed Message:\n" + ascii(byteLen(M)) + M)`
  where `M` is the RFC 9421 signature base string. Signature = 65 bytes `r(32)||s(32)||v(1)`,
  base64 in the `Signature` header (label `eth`).
- **Covered components (min):** `@authority` (always), `@method`, `@path`, `@query`
  (if present), `content-digest` (if a body). `nonce` is a `Signature-Input`
  parameter, not a covered component.
- **Verify:** rebuild `M` → `H` → secp256k1-recover the address → compare
  (case-insensitive) to the keyid address; check the `created`/`expires` freshness
  window. A match yields `attestation: "signed"` (or `"registry_attested"` when
  `identityOf` binds the address to a principal).
- **ERC-1271 (contract signer):** smart-contract signers can't be recovered by plain
  secp256k1. Inject an `eth_call`-backed `resolveContractSig` callback (default off —
  plain ERC-8128 needs no RPC).

```ts
import { erc8128Verifier } from "@general-liquidity/agentworth/identity";

const verifier = erc8128Verifier({
  // identityOf?: bind a verified address to a principal → registry_attested
  // resolveContractSig?: optional ERC-1271 eth_call callback
});

const result = await verifier.verify(signedRequest); // SignedRequest from RFC 9421
// result.identity.attestation === "signed" when the recovered address matches keyid
```

Helpers: `parseErc8128KeyId`, `eip191Hash`, `recoverErc8128Address`, and `signErc8128`
(the signer, provided so callers/tests can round-trip).

## SIWA — Sign-In-With-Agent

SIWA is a **SIWE-style plaintext message** (not a JWT), EIP-191 signed by the agent's
wallet. The message text is signed verbatim:

```
{domain} wants you to sign in with your Agent account:
{address}

{statement}

URI: {uri}
Version: 1
Agent ID: {agentId}
Agent Registry: {agentRegistry}
Chain ID: {chainId}
Nonce: {nonce}
Issued At: {issuedAt}
```

Optional trailing lines (`Expiration Time`, `Not Before`, `Request ID`) appear only
when present. `agentRegistry` is a CAIP-10 id (`eip155:<chainId>:<registry>`).

**Verify:** EIP-191-recover the signer and require it to equal `address`; check the
domain, nonce and expiry window. Then, if an ERC-8004 `ownerOf` resolver is injected,
`ownerOf(agentId) == signer` lifts the verdict from `signed` to `registry_attested`.

```ts
import { verifySiwa, siwaIdentityVerifier } from "@general-liquidity/agentworth/identity";

const res = await verifySiwa(msg, signature /* 65-byte r||s||v */, {
  expectedDomain: "app.example.com",
  nonceValid: (n) => knownNonces.has(n),
  resolveRegistry: async (registry, agentId) => fetchOwnerOf(registry, agentId),
});
// res.identity.attestation: "signed" (no resolver / owner≠signer) | "registry_attested"
```

`siwaIdentityVerifier(opts)` adapts the above to the `IdentityVerifier` shape; its
presented artifact is `{ message: SiwaMessage | string; signature: Uint8Array }`.
Helpers: `formatSiwaMessage`, `parseSiwaMessage`.

## Self proofs (`mapSelfToAttestation`)

OS does **not** verify a Self (Self Protocol) proof itself — full proof verification
is delegated to ADP / the Self SDK. OS only consumes the boolean verdict as a risk
input:

```ts
import { mapSelfToAttestation } from "@general-liquidity/agentworth/identity";

mapSelfToAttestation({ valid: true, registryBacked: true }); // "registry_attested"
mapSelfToAttestation({ valid: true });                       // "signed"
mapSelfToAttestation({ valid: false });                      // "none"
```

## Dependencies

`@noble/curves` and `@noble/hashes` are **optional dependencies** — they are imported
dynamically only inside the recover/hash functions. If a deployment never uses the
on-chain verifiers, they need not be installed; calling an on-chain verifier without
them throws a clear, actionable error.
