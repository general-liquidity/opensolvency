// Core domain types for the OpenSolvency trust kernel.
//
// Money is ALWAYS integer minor-units (cents, satoshis, wei-scaled) — never floats.
// Time is ALWAYS an injected ISO-8601 string — the kernel never reads the clock,
// so every decision is deterministic and replayable from the audit log.

export type CurrencyCode = string; // ISO-4217 ("GBP") or token symbol ("USDC")

export type RailKind = "onchain" | "card" | "checkout";

/** Whether a settled payment can be clawed back. Drives risk + deny rules. */
export type Reversibility = "reversible" | "irreversible";

export const RAIL_REVERSIBILITY: Record<RailKind, Reversibility> = {
  card: "reversible",
  checkout: "reversible",
  onchain: "irreversible",
};

/** Who a mandate is allowed to pay. */
export type PayeeScope =
  | { kind: "class"; value: string } // e.g. "groceries", "saas"
  | { kind: "allowlist"; values: string[] }; // explicit payee ids

export type Period = "day" | "week" | "month";

export type MandateStatus = "active" | "revoked";

/**
 * A Mandate is operator-granted, scoped, capped, expiring, revocable spend authority.
 * It is the ONLY thing that can authorize an agent payment without a live human confirm.
 * This is the central object of the whole system.
 */
export interface Mandate {
  id: string;
  label: string; // human name, e.g. "weekly groceries"
  scope: PayeeScope;
  currency: CurrencyCode;
  allowedRails: RailKind[];
  perTxCap: number; // minor-units; a single payment may not exceed this
  perPeriodCap: number; // minor-units; rolling-period total may not exceed this
  period: Period;
  grantedAt: string; // ISO
  expiresAt: string; // ISO; mandate is dead after this instant
  status: MandateStatus;
}

/** A concrete payment the agent wants to make. Validated at the boundary. */
export interface PaymentIntent {
  id: string;
  payee: string; // stable payee id
  payeeClass: string; // the class this payee belongs to ("groceries")
  amount: number; // minor-units, must be > 0
  currency: CurrencyCode;
  rail: RailKind;
  rationale: string; // required; logged to audit (intent, not just the call)
  createdAt: string; // ISO
}

/** How strongly the ACTING AGENT's identity is established (agent-identity layer:
 * AIP / Visa Trusted Agent Protocol). `none` = unverified, `signed` = a verifiable
 * signature (e.g. an XMTP sender), `registry_attested` = an issuer-attested agent
 * bound to a principal. Feeds the gate's risk; never relaxes the floor. */
export type Attestation = "none" | "signed" | "registry_attested";

/** A payee's cross-ecosystem reputation (an injected network reputation source —
 * distinct from the operator's own per-payee trust trajectory). Feeds the gate's
 * risk; never relaxes the floor. */
export type ReputationLevel = "good" | "neutral" | "flagged" | "unknown";

export type SpendRiskTier = "none" | "low" | "medium" | "high";

export interface SpendRisk {
  tier: SpendRiskTier;
  score: number;
  reasons: string[];
}

/** Proof of a settled payment, returned by a rail and stored in the ledger. */
export type SettlementFinality = "final" | "reversible" | "pending";

export interface Receipt {
  id: string;
  intentId: string;
  rail: RailKind;
  amount: number; // minor-units
  currency: CurrencyCode;
  settledAt: string; // ISO
  providerRef: string; // the rail's own reference (tx hash, charge id, …)
  finality: SettlementFinality;
}

export type GateOutcome = "auto_execute" | "confirm_operator" | "block";

export interface GateDecision {
  outcome: GateOutcome;
  reasons: string[];
  mandateId: string | null; // the mandate that authorized it, if any
  risk: SpendRisk;
  /** period budget left AFTER this payment, if a mandate matched (minor-units) */
  remainingPeriodBudget: number | null;
}

export interface GateConfig {
  minRationaleChars: number;
  /** payments within this window count toward the velocity ceiling */
  velocityWindowMinutes: number;
  /** more than this many payments in the window forces an operator confirm */
  velocityMaxCount: number;
  /** amount above this multiple of the period's median payment is anomalous */
  anomalyMultiple: number;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  minRationaleChars: 10,
  velocityWindowMinutes: 60,
  velocityMaxCount: 5,
  anomalyMultiple: 3,
};

/** A prior executed payment in the current period, used for budget + velocity + anomaly. */
export interface PriorSpend {
  amount: number; // minor-units
  at: string; // ISO
}

/** Everything the pure gate needs to decide. No I/O, no clock.
 * `periodSpendByMandate` is a pure lookup the caller closes over already-fetched
 * data with — the gate selects the authorizing mandate, then asks for its spend. */
export interface GateContext {
  now: string; // ISO — injected
  mandates: Mandate[];
  periodSpendByMandate: (mandateId: string) => PriorSpend[];
  /** payees the operator has paid before (novelty check) */
  knownPayees: ReadonlySet<string>;
  /** Trust level per payee (settlement history). When absent, the gate falls back
   * to the binary knownPayees (seen/new). Trust relaxes scrutiny, never the floor. */
  trustOf?: (payee: string) => import("./trust.ts").TrustLevel;
  /** Convert a foreign-currency amount into a mandate's currency (FX). When a
   * payment's currency differs from the mandate's, the gate uses this for cover +
   * caps; if it returns undefined (no rate) the mandate does not cover the payment. */
  convert?: (amountMinor: number, from: string, to: string) => number | undefined;
  /** Attestation level of the acting agent (from the identity layer). Undefined =
   * not evaluated (no effect). Feeds risk; never relaxes caps/deny-list. */
  attestation?: Attestation;
  /** A payee's network reputation (injected). Undefined = not evaluated. Feeds
   * risk; never relaxes the floor. */
  reputationOf?: (payee: string) => ReputationLevel | undefined;
  denyRules: DenyRule[];
  config: GateConfig;
  /** Reversibility of the PROVIDER that will settle this intent (injected by the
   * executor from the resolved rail's capabilities). Falls back to the RailKind's
   * static reversibility when absent — so a rail-agnostic provider that settles
   * irreversibly (e.g. MPP→stablecoin) is risked as irreversible, not as its kind. */
  reversibility?: Reversibility;
}

/**
 * A hard deny rule. If any rule matches, the payment is BLOCKED regardless of
 * mandate or accumulated trust — the deny-list is never overridable by trust.
 */
export interface DenyRule {
  id: string;
  reason: string;
  match: (
    intent: PaymentIntent,
    ctx: { knownPayees: ReadonlySet<string>; reversibility: Reversibility },
  ) => boolean;
}
