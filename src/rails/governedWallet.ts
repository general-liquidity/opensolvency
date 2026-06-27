// GOVERNED WALLET — put the OS gate ABOVE an agent's wallet.
//
// The audit's #1 defense against a custody layer (Coinbase CDP Spend Permissions /
// AgentKit, or any agent-controlled wallet) ABSORBING the governance gate: OS does
// not become a wallet, and the wallet does not become the policy. Instead the wallet
// spend is routed THROUGH `evaluateGate` first, and the live wallet call only fires
// when the gate returns `auto_execute`. On `confirm_operator` / `block` the money
// does NOT move — the caller gets the decision and routes to the operator.
//
// DEP-LIGHT INJECTED-SEAM PATTERN (mirrors the World ID / AgentBook verifiers): OS
// CANNOT and MUST NOT bundle a wallet SDK. The consumer wires the live spend as an
// injected `execute` seam — a CDP `account.sendTransaction` / Spend-Permission spend,
// an AgentKit action, an ERC-4337 userOp, anything. OS owns only the gate above it.
//
// The wallet-spend request is defined STRUCTURALLY (`{ wallet, to, amount,
// token/currency, network }`), mapped to a `PaymentIntent`, and gated. This is a
// governance WRAPPER, not a rail: a rail SETTLES an already-authorized intent; this
// AUTHORIZES (or refuses) a spend the wallet itself will settle.

import { evaluateGate } from "../core/gate.ts";
import type {
  Attestation,
  GateContext,
  GateDecision,
  PaymentIntent,
} from "../core/types.ts";

/**
 * A wallet-spend request as an agent wallet expresses it — structural, SDK-free.
 * Maps onto a `PaymentIntent`. `token` is the currency (a symbol like "USDC" or an
 * ISO-4217 code); `network` is informational (the chain/venue) and rides along as
 * the payee class default unless `payeeClass` is given explicitly.
 */
export interface WalletSpendRequest {
  /** Source wallet / account address the spend debits. */
  wallet: string;
  /** Destination address or stable payee id. */
  to: string;
  /** Amount in MINOR units (integer) — never a float. Matches the gate's contract. */
  amount: number;
  /** Currency: a token symbol ("USDC", "ETH") or ISO-4217 code. `currency` alias accepted. */
  token?: string;
  currency?: string;
  /** Chain / venue, e.g. "base", "ethereum". Informational; defaults the payee class. */
  network?: string;
  /** Operator-facing reason; logged by the gate as intent, not just the call. */
  rationale?: string;
  /** Payee class for mandate scoping (`{ kind: "class" }`). Defaults to `network`. */
  payeeClass?: string;
  /** Stable payee id for novelty / allowlist scope. Defaults to `to`. */
  payee?: string;
  /** Optional explicit intent id; otherwise derived from `to`+`amount`+time. */
  id?: string;
}

export interface CdpSpendToIntentOptions {
  now: string;
  /** Override the derived intent id. */
  id?: string;
  /** Rail kind to settle on. CDP / on-chain wallets are `onchain` (irreversible). */
  rail?: PaymentIntent["rail"];
}

const FALLBACK_RATIONALE =
  "agent wallet spend gated through AgentWorth before execution";

/**
 * Map a structural wallet-spend request (CDP Spend Permission / AgentKit action /
 * any wallet) onto an OS `PaymentIntent`. Pure: no clock read, no I/O — `now` is
 * injected so the mapping is deterministic and replayable, like the rest of the
 * kernel. Defaults: rail `onchain` (a wallet send is irreversible), payee = `to`,
 * payee class = `network`.
 */
export function cdpSpendToIntent(
  req: WalletSpendRequest,
  opts: CdpSpendToIntentOptions,
): PaymentIntent {
  const currency = req.currency ?? req.token;
  if (!currency) {
    throw new Error("wallet spend is missing a token/currency");
  }
  const payee = req.payee ?? req.to;
  return {
    id: req.id ?? opts.id ?? `cdp_${payee}_${req.amount}_${opts.now}`,
    payee,
    payeeClass: req.payeeClass ?? req.network ?? "wallet_spend",
    amount: req.amount,
    currency,
    rail: opts.rail ?? "onchain",
    rationale: req.rationale ?? FALLBACK_RATIONALE,
    createdAt: opts.now,
  };
}

/** Proof the injected wallet seam actually moved the money. Opaque to OS. */
export interface WalletSpendReceipt {
  /** The wallet's own reference: a tx hash, userOp hash, spend-permission id, … */
  ref: string;
  [extra: string]: unknown;
}

/**
 * The live wallet call. INJECTED by the consumer — OS bundles no wallet SDK. Invoked
 * ONLY after the gate returns `auto_execute`. Receives both the raw structural request
 * and the mapped intent so the seam can build its native call however it needs.
 */
export type WalletExecuteSeam = (
  req: WalletSpendRequest,
  intent: PaymentIntent,
) => Promise<WalletSpendReceipt> | WalletSpendReceipt;

export interface GovernedWalletResult {
  /** The gate's verdict. `auto_execute` is the ONLY outcome that ran the seam. */
  decision: GateDecision;
  /** The intent the request was gated as. */
  intent: PaymentIntent;
  /** True only when the injected `execute` seam was actually invoked. */
  executed: boolean;
  /** The wallet's receipt, present iff `executed`. */
  receipt: WalletSpendReceipt | null;
}

/**
 * Build the gate context for a spend. Either an explicit `GateContext` (or a thunk
 * that builds one per-spend, so spend history can advance between calls), or — when
 * the consumer holds the OS executor — they can pass their own gate closure. Kept
 * dep-light: the wrapper only needs `evaluateGate`, not the full executor/store.
 */
export type GateContextSource =
  | GateContext
  | ((intent: PaymentIntent) => GateContext);

export interface GovernedWalletDeps {
  /** The gate context (or a per-spend builder). */
  gate: GateContextSource;
  /** The injected live wallet spend — fired only on `auto_execute`. */
  execute: WalletExecuteSeam;
  /** Default rail for the mapping; `onchain` (irreversible) by default. */
  rail?: PaymentIntent["rail"];
  /** Injected clock for the intent's `createdAt` when the request omits an id/time.
   * Defaults to `() => new Date().toISOString()`; tests inject a fixed string. */
  now?: () => string;
}

/**
 * A governed wallet: gate a spend, and execute the injected seam ONLY when the gate
 * authorizes it autonomously. Returns the decision in every case so the caller can
 * route `confirm_operator` to the operator and surface `block` reasons — the money
 * never moves on those paths.
 */
export function governedWallet(deps: GovernedWalletDeps) {
  const clock = deps.now ?? (() => new Date().toISOString());

  function contextFor(intent: PaymentIntent): GateContext {
    return typeof deps.gate === "function" ? deps.gate(intent) : deps.gate;
  }

  async function spend(
    req: WalletSpendRequest,
    opts: { attestation?: Attestation } = {},
  ): Promise<GovernedWalletResult> {
    const now = clock();
    const intent = cdpSpendToIntent(req, { now, rail: deps.rail });
    const ctx = contextFor(intent);
    const decision = evaluateGate(intent, {
      ...ctx,
      attestation: opts.attestation ?? ctx.attestation,
    });

    if (decision.outcome !== "auto_execute") {
      // confirm_operator / block: the money does NOT move. Return the verdict.
      return { decision, intent, executed: false, receipt: null };
    }

    const receipt = await deps.execute(req, intent);
    return { decision, intent, executed: true, receipt };
  }

  return { spend, cdpSpendToIntent };
}

export type GovernedWallet = ReturnType<typeof governedWallet>;
