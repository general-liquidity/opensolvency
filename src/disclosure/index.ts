// Verifiable Agency in OpenSolvency. The vendor-neutral protocol + reference verifier
// now live in the standalone `@general-liquidity/agent-disclosure` package; this
// module re-exports that surface and adds the OpenSolvency-specific pieces that do
// NOT lift out: the field builders (populate a disclosure from the live gate /
// mandates / signed audit chain / SpendTrust) and the reference adversarial corpus.
// OpenSolvency is the protocol's reference implementation.

export * from "@general-liquidity/agent-disclosure";

// OpenSolvency field builders (populate a disclosure from live primitives).
export * from "./builders.ts";

// The OpenSolvency reference adversarial corpus (SpendTrust + deny-list).
export * from "./corpus.ts";
