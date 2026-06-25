// Identity layer — agent-identity verifiers that feed the gate's `attestation` input
// (never the floor: identity informs risk/trust, it cannot relax caps or the deny-list).
// Exposed as the `@general-liquidity/opensolvency/identity` subpath.
//
//  - verifier.ts: the IdentityVerifier contract + AIP / Visa Trusted Agent Protocol
//    (RFC 9421, ed25519) + the dev static verifier, plus the reusable RFC 9421 helpers.
//  - erc8128.ts:  ERC-8128 — Ethereum-wallet-signed HTTP requests (RFC 9421 + EIP-191 + secp256k1).
//  - siwa.ts:     SIWA (Sign-In-With-Agent) — a SIWE-style login bound to an ERC-8004 agent id,
//                 plus `mapSelfToAttestation` (a verified Self proof as a gate risk input).
//  - worldId.ts:  World ID — Worldcoin proof-of-personhood (injected verifier) → the gate's
//                 `attestation`; the `nullifier_hash` is the per-(human, action) sybil key.
//  - worldAgent.ts: World Agent (worldcoin/agentkit) — an agent backed by a World ID-verified
//                 human; EIP-191 signer recovery + an injected AgentBook (`lookupHuman`) resolver.
//  - passport.ts: Human Passport — a humanity score → the gate's `ReputationLevel` (injected scorer).
export * from "./verifier.ts";
export * from "./erc8128.ts";
export * from "./siwa.ts";
export * from "./worldId.ts";
export * from "./worldAgent.ts";
export * from "./passport.ts";
