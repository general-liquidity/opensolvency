# Proof-of-personhood — World ID & Human Passport

AgentWorth never issues identity. It **consumes** an identity verdict as a risk
input to the gate. Two proof-of-personhood sources plug into the existing identity
layer alongside `visaTapVerifier`, ERC-8128, and SIWA:

- **World ID** (Worldcoin) → the gate's `Attestation` input (`none | signed | registry_attested`).
- **Human Passport** (formerly Gitcoin Passport) → the gate's `reputationOf` input
  (`good | neutral | flagged | unknown`).

Both feed the gate's **risk** and **never relax the floor** — caps and the deny-list
are never overridable by a strong attestation or a high humanity score. Neither
verifier opens a socket from the kernel: the cryptographic / network step is an
**injected callback**, so the core stays deterministic and dependency-free.

## World ID — proof-of-personhood as `attestation`

A World ID proof is a Groth16 zero-knowledge proof over the on-chain Orb identity
set. AgentWorth **cannot verify it locally** (no trusted setup, no Merkle
membership in the kernel), so — like the Self path — OS consumes the verdict of an
**injected `WorldIdVerifier`**. The consumer wires either the Worldcoin cloud
`/verify` endpoint or the on-chain Router `verifyProof`. Without a verifier the
result is **structural-only** (`verified: false`, attestation `none`) — never thrown.

The `nullifier_hash` is the **per-(human, action) sybil key**: one human can produce
at most one distinct nullifier for a given `(app_id, action)`, so OS uses it as the
stable, privacy-preserving `agentId`.

### Attestation mapping

| verification level | valid | `Attestation` |
|---|---|---|
| any | `false` | `none` |
| `orb` | `true` | `registry_attested` (issuer-attested human) |
| `device` / `document` / `secure_document` | `true` | `signed` |

```ts
import { worldIdIdentityVerifier } from "@general-liquidity/agentworth/identity";

const verifier = worldIdIdentityVerifier({
  // consumer wires the cloud /verify endpoint or the on-chain Router verifyProof
  verifier: async (a) => {
    const res = await fetch(`https://developer.worldcoin.org/api/v2/verify/${a.app_id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nullifier_hash: a.nullifier_hash,
        merkle_root: a.merkle_root,
        proof: a.proof,
        verification_level: a.verification_level,
        action: a.action,
        signal: a.signal,
      }),
    });
    const json = await res.json();
    return { valid: res.ok && json.success === true, nullifier: a.nullifier_hash };
  },
});

const result = await verifier.verify(worldIdAttestation);
// result.identity.attestation feeds GateContext.attestation
// result.identity.agentId === nullifier_hash (the sybil key)
```

`validateWorldIdStructural` / `verifyWorldId` / `mapWorldIdToAttestation` are exported
for callers that want the structural check or the verdict without the
`IdentityVerifier` adapter.

## Human Passport — a humanity score as `reputationOf`

A Human Passport aggregates verified **stamps** into an aggregate humanity score. OS
maps that score to a `ReputationLevel`. The score is fetched by an **injected
`PassportScorer`** (the Passport Stamps / Models API client). The Models API returns
the score as a **numeric string** — the consumer's scorer parses it to a number at the
boundary; OS only consumes the numeric verdict. Without a scorer, the attestation's
embedded `score` is used.

### Score → `ReputationLevel`

The default threshold is the Stamps passing threshold, `HUMAN_THRESHOLD = 20`:

| score | level |
|---|---|
| `undefined` / `NaN` | `unknown` |
| `>= threshold` (20) | `good` |
| `>= threshold/2` (10) | `neutral` |
| below | `flagged` |

For the **0–100 Models API**, pass `threshold = 100` (so `>= 100 good`, `>= 50 neutral`,
else `flagged`) — or rescale to taste.

```ts
import { passportReputationOf } from "@general-liquidity/agentworth/identity";

const reputationOf = await passportReputationOf(passportAttestation, {
  scorer: async (address) => {
    const res = await fetch(`https://api.passport.xyz/v2/stamps/${scorerId}/score/${address}`, {
      headers: { "X-API-KEY": apiKey },
    });
    const json = await res.json();
    return { score: Number(json.score), passing: json.passing_score, threshold: Number(json.threshold) };
  },
});

// reputationOf is the exact shape GateContext.reputationOf consumes:
//   reputationOf(payee) → ReputationLevel  (the attested address's level, else "unknown")
```

`passportToReputationLevel` and `verifyPassport` are exported for callers that want the
mapping or the `{ level, score, passing }` verdict directly.
