// Compliance seam — pluggable sanctions/OFAC + AML screening that feeds the
// EXISTING gate without touching the core. A ComplianceProvider screens a
// payment intent's payee/counterparty and returns a verdict:
//
//   clear              — no hit
//   flagged(riskBump)  — suspicious; raises spend-risk but does not block
//   blocked(reason)    — a sanctions/deny hit; the payment is refused
//
// Two integration shapes, both additive (compliance can only ADD denials/risk,
// never relax the gate floor):
//
//   denyRuleFromCompliance(provider)   → a DenyRule (denyList.ts predicate shape)
//                                        so a `blocked` verdict plugs straight
//                                        into ctx.denyRules — the cleanest wiring.
//   reputationFromCompliance(provider) → a reputationOf() that maps `flagged`
//                                        to "flagged", feeding the risk classifier
//                                        through the gate's existing seam.
//
// The screener is a pure list/predicate engine: the provider seam is injectable,
// so a real OFAC/AML API is never called here — a deterministic ListScreener
// against an injected list is the reference implementation.

import type {
  DenyRule,
  PaymentIntent,
  ReputationLevel,
  Reversibility,
} from "../core/types.ts";

/** A screening verdict over a single payment intent. */
export type ComplianceVerdict =
  | { status: "clear"; reasons?: string[] }
  | { status: "flagged"; riskBump: number; reasons: string[] }
  | { status: "blocked"; reason: string };

/** The pluggable compliance seam. An implementation screens a payment's
 * payee/counterparty (and may consult the broader intent) → a verdict.
 * Pure + synchronous, like the rest of the trust kernel: no I/O, no clock. */
export interface ComplianceProvider {
  id: string;
  screen(
    intent: PaymentIntent,
    ctx?: { knownPayees: ReadonlySet<string>; reversibility: Reversibility },
  ): ComplianceVerdict;
}

/** An OFAC-SDN-shaped sanctions/deny entry. Any matched field is a hit. Matching
 * is exact (case/space-normalized) on names/aliases and the stable payee id, and
 * exact on chain addresses (lowercased) — list screening is deliberately literal,
 * not fuzzy, so the deny path is deterministic and auditable. */
export interface SanctionEntry {
  /** stable id of the listing, e.g. "OFAC-SDN-12345" — surfaced in the reason */
  ref: string;
  /** primary name, e.g. "ACME LAUNDERING LLC" */
  name?: string;
  /** known aliases / a.k.a. */
  aliases?: string[];
  /** stable payee ids that map to this listing (the gate's `intent.payee`) */
  payees?: string[];
  /** sanctioned chain addresses (EVM/Solana/…); compared lowercased */
  chainAddresses?: string[];
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Build a fast lookup from a list of SDN-shaped entries. */
function indexEntries(entries: SanctionEntry[]): {
  byName: Map<string, SanctionEntry>;
  byPayee: Map<string, SanctionEntry>;
  byAddress: Map<string, SanctionEntry>;
} {
  const byName = new Map<string, SanctionEntry>();
  const byPayee = new Map<string, SanctionEntry>();
  const byAddress = new Map<string, SanctionEntry>();
  for (const e of entries) {
    if (e.name) byName.set(norm(e.name), e);
    for (const a of e.aliases ?? []) byName.set(norm(a), e);
    for (const p of e.payees ?? []) byPayee.set(norm(p), e);
    for (const addr of e.chainAddresses ?? []) byAddress.set(norm(addr), e);
  }
  return { byName, byPayee, byAddress };
}

export interface ListScreenerOptions {
  /** the sanctions/deny list to screen against (OFAC-SDN-shaped) */
  list: SanctionEntry[];
  /** id for the produced verdicts/rules (default "list-screener") */
  id?: string;
}

/**
 * The reference ComplianceProvider: deterministic screening of a payment's
 * payee against an injected sanctions/deny list. A hit on the payee id, the
 * payee string-as-name/alias, or the payee-as-chain-address → `blocked` with a
 * reason that names the matched listing. No hit → `clear`. This is a pure
 * list/predicate engine — no network, no real OFAC API.
 */
export class ListScreener implements ComplianceProvider {
  readonly id: string;
  private readonly idx: ReturnType<typeof indexEntries>;

  constructor(opts: ListScreenerOptions) {
    this.id = opts.id ?? "list-screener";
    this.idx = indexEntries(opts.list);
  }

  screen(
    intent: PaymentIntent,
    _ctx?: { knownPayees: ReadonlySet<string>; reversibility: Reversibility },
  ): ComplianceVerdict {
    const payee = norm(intent.payee);
    const hit =
      this.idx.byPayee.get(payee) ??
      this.idx.byName.get(payee) ??
      this.idx.byAddress.get(payee);
    if (hit) {
      return {
        status: "blocked",
        reason: `payee matches sanctions/deny listing ${hit.ref}${
          hit.name ? ` (${hit.name})` : ""
        }`,
      };
    }
    return { status: "clear" };
  }
}

/**
 * Produce a DenyRule (the EXISTING denyList.ts predicate shape) from a compliance
 * provider, so a `blocked` verdict refuses the payment through the gate's normal
 * deny path — no core changes. A `flagged`/`clear` verdict is NOT a deny here
 * (use reputationFromCompliance for the risk bump); this rule only ever ADDS a
 * denial, preserving the gate floor.
 */
export function denyRuleFromCompliance(
  provider: ComplianceProvider,
  reason = "sanctions/AML compliance screening hit",
): DenyRule {
  return {
    id: `compliance:${provider.id}`,
    reason,
    match: (intent, ctx) => provider.screen(intent, ctx).status === "blocked",
  };
}

/**
 * Map a provider's `flagged` verdict onto the gate's existing reputation seam
 * (`reputationOf`), so a suspicious-but-not-sanctioned payee raises spend-risk
 * via the risk classifier without a core change. A `blocked` payee surfaces as
 * "flagged" too (it's also caught by the deny rule, which takes precedence);
 * a `clear` payee yields undefined ("not evaluated"). Compose with any prior
 * reputation source via `base`. */
export function reputationFromCompliance(
  provider: ComplianceProvider,
  ctx: { knownPayees: ReadonlySet<string>; reversibilityOf: (i: PaymentIntent) => Reversibility },
  base?: (payee: string) => ReputationLevel | undefined,
): (intent: PaymentIntent) => ReputationLevel | undefined {
  return (intent) => {
    const v = provider.screen(intent, {
      knownPayees: ctx.knownPayees,
      reversibility: ctx.reversibilityOf(intent),
    });
    if (v.status === "flagged" || v.status === "blocked") return "flagged";
    return base?.(intent.payee);
  };
}
