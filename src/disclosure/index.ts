// Verifiable Agency in AgentWorth. The vendor-neutral protocol + reference verifier
// now live in the standalone `@general-liquidity/agent-disclosure` package; this
// module re-exports that surface and adds the AgentWorth-specific pieces that do
// NOT lift out: the field builders (populate a disclosure from the live gate /
// mandates / signed audit chain / SpendTrust) and the reference adversarial corpus.
// AgentWorth is the protocol's reference implementation.

export * from "@general-liquidity/agent-disclosure";

// AgentWorth field builders (populate a disclosure from live primitives).
export * from "./builders.ts";

// The AgentWorth reference adversarial corpus (SpendTrust + deny-list).
export * from "./corpus.ts";
