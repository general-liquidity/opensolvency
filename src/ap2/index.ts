// AP2 (Agent Payments Protocol) interop for AgentWorth.
//
// AP2 (google-agentic-commerce/AP2) carries spend authorization between agents as
// three mandates — IntentMandate (coarse user intent), CartMandate (a merchant's
// signed cart), PaymentMandate (the binding to a payment method) — passed in A2A
// Message DataParts. AgentWorth is the POLICY ENGINE behind AP2 authorization:
// an AP2 CartMandate becomes an AgentWorth PaymentIntent and runs through `evaluateGate`,
// which decides auto_execute / confirm_operator / block under the operator's
// mandates, caps, deny-list, and risk. This module is the seam, nothing more — it
// re-implements no policy; it maps shapes and calls into the existing kernel.
//
// Wire shape is snake_case (the AP2 pydantic models are snake_case) and is kept
// verbatim in the TS interfaces below — these are the wire types, not AgentWorth types, so
// they are deliberately NOT camelCased.
//
// Documented assumptions (AP2 leaves these unspecified):
//  - cart_hash canonicalization: RFC 8785 JCS (we reuse the ADP `canonicalize`,
//    which is a JCS implementation), hashed with SHA-256.
//  - Money: W3C PaymentCurrencyAmount.value is MAJOR units (a number, e.g. "12.50"
//    dollars); AgentWorth money is integer MINOR units. Converted with an injectable
//    `minorUnitsPerMajor` (default 100).
//  - PaymentMandate VP crypto (issuer/holder SD-JWT-VC signatures) is OUT OF SCOPE
//    and delegated to a VC verifier. `verifyPaymentMandateBinding` does STRUCTURAL
//    binding only: the cart→payment transaction_data hashes + details-id linkage.

import { createHash, verify as nodeVerify } from "node:crypto";
import type { KeyObject } from "node:crypto";

import { canonicalize as adpCanonicalize } from "@general-liquidity/agent-disclosure";
import { evaluateGate } from "../core/gate.ts";
import type {
  CurrencyCode,
  GateConfig,
  GateContext,
  GateDecision,
  Mandate,
  PaymentIntent,
  Period,
  RailKind,
} from "../core/types.ts";

// --- AP2 constants -----------------------------------------------------------

/** AP2 A2A extension URI (AgentCard `capabilities.extensions[].uri`). */
export const AP2_EXTENSION_URI =
  "https://github.com/google-agentic-commerce/ap2/tree/v0.1";

/** DataPart `data` keys the three mandates are carried under. */
export const AP2_DATA_KEYS = {
  intent: "ap2.mandates.IntentMandate",
  cart: "ap2.mandates.CartMandate",
  payment: "ap2.mandates.PaymentMandate",
} as const;

export type Ap2Role = "merchant" | "shopper" | "credentials-provider" | "payment-processor";

// --- AP2 wire types (snake_case — the wire shape) ----------------------------

export interface IntentMandate {
  user_cart_confirmation_required: boolean;
  natural_language_description: string;
  merchants?: string[] | null;
  skus?: string[] | null;
  requires_refundability?: boolean | null;
  intent_expiry: string; // ISO-8601
}

/** W3C Payment Request `PaymentCurrencyAmount`. `value` is in MAJOR units. */
export interface PaymentCurrencyAmount {
  currency: string;
  value: number;
}

export interface PaymentItem {
  label: string;
  amount: PaymentCurrencyAmount;
  pending?: boolean;
  refund_period?: number;
}

export interface PaymentMethodData {
  supported_methods: string;
  data?: Record<string, unknown> | null;
}

export interface PaymentDetailsInit {
  id: string;
  display_items: PaymentItem[];
  total: PaymentItem;
  shipping_options?: unknown[] | null;
  modifiers?: unknown[] | null;
}

export interface PaymentRequest {
  method_data: PaymentMethodData[];
  details: PaymentDetailsInit;
  options?: Record<string, unknown> | null;
  shipping_address?: Record<string, unknown> | null;
}

export interface CartContents {
  id: string;
  user_cart_confirmation_required: boolean;
  payment_request: PaymentRequest;
  cart_expiry: string; // ISO-8601
  merchant_name: string;
}

export interface CartMandate {
  contents: CartContents;
  /** base64url JWT (header.payload.sig), claims iss/sub/aud/iat/exp/jti + cart_hash. */
  merchant_authorization?: string | null;
}

export interface PaymentMandateContents {
  payment_mandate_id: string;
  payment_details_id: string;
  payment_details_total: PaymentItem;
  payment_response: Record<string, unknown>;
  merchant_agent: string;
  timestamp: string;
}

export interface PaymentMandate {
  payment_mandate_contents: PaymentMandateContents;
  /** SD-JWT-VC VP; its KB-JWT carries transaction_data = [hash(CartMandate),
   * hash(PaymentMandateContents)]. Full VP crypto is out of scope (delegated). */
  user_authorization?: string | null;
}

// --- canonicalization / hashing ----------------------------------------------

/** RFC 8785 JCS canonical JSON. Reuses the ADP implementation so AgentWorth and ADP
 * agree on the canonical form used for hashing. */
export function canonicalize(value: unknown): string {
  return adpCanonicalize(value);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** The cart_hash: SHA-256 over the JCS-canonical CartContents (hex). */
export function cartHash(
  contents: CartContents,
  canon: (v: unknown) => string = canonicalize,
): string {
  return sha256Hex(canon(contents));
}

// --- Mandate ⇄ IntentMandate (pure) ------------------------------------------

/** Map an AgentWorth Mandate to an AP2 IntentMandate. AP2's IntentMandate is COARSER than
 * an AgentWorth Mandate: it carries no amount caps (perTxCap/perPeriodCap have no native
 * field). Those are dropped here and must be re-supplied on ingest. */
export function mandateToIntentMandate(
  m: Mandate,
  opts: { description?: string } = {},
): IntentMandate {
  return {
    user_cart_confirmation_required: true,
    natural_language_description: opts.description ?? m.label,
    merchants: m.scope.kind === "allowlist" ? m.scope.values : null,
    skus: null,
    requires_refundability: false,
    intent_expiry: m.expiresAt,
  };
}

export interface IntentMandateToMandateOpts {
  id: string;
  label?: string;
  currency: CurrencyCode;
  allowedRails: RailKind[];
  perTxCap: number;
  perPeriodCap: number;
  period: Period;
  grantedAt: string;
  /** Payee class used when the IntentMandate has no merchant allowlist. */
  payeeClass?: string;
}

/** Map an AP2 IntentMandate to an AgentWorth Mandate. AP2 carries no caps, so the caller
 * supplies perTxCap / perPeriodCap / period / currency / rails via `opts`. */
export function intentMandateToMandate(
  im: IntentMandate,
  opts: IntentMandateToMandateOpts,
): Mandate {
  return {
    id: opts.id,
    label: opts.label ?? im.natural_language_description,
    scope:
      im.merchants && im.merchants.length > 0
        ? { kind: "allowlist", values: im.merchants }
        : { kind: "class", value: opts.payeeClass ?? "ap2" },
    currency: opts.currency,
    allowedRails: opts.allowedRails,
    perTxCap: opts.perTxCap,
    perPeriodCap: opts.perPeriodCap,
    period: opts.period,
    grantedAt: opts.grantedAt,
    expiresAt: im.intent_expiry,
    status: "active",
  };
}

// --- CartMandate → PaymentIntent ---------------------------------------------

const DEFAULT_MINOR_UNITS_PER_MAJOR = 100;

/** Total of a cart in AgentWorth minor-units + its currency. `value` is W3C major units;
 * convert with `minorUnitsPerMajor` (default 100). Rounds to the nearest integer
 * minor-unit (W3C values may carry sub-cent precision). */
export function cartTotal(
  cart: CartMandate,
  minorUnitsPerMajor: number = DEFAULT_MINOR_UNITS_PER_MAJOR,
): { amount: number; currency: string } {
  const total = cart.contents.payment_request.details.total.amount;
  return {
    amount: Math.round(total.value * minorUnitsPerMajor),
    currency: total.currency,
  };
}

export interface CartMandateToIntentOpts {
  id: string;
  payeeClass: string;
  rail: RailKind;
  rationale: string;
  createdAt: string;
  minorUnitsPerMajor?: number;
}

/** Turn an AP2 CartMandate into an AgentWorth PaymentIntent. The payee is the cart's
 * `merchant_name`; amount + currency come from the cart total. Everything the
 * gate needs but AP2 doesn't carry (payeeClass, rail, rationale) comes from opts. */
export function cartMandateToIntent(
  cart: CartMandate,
  opts: CartMandateToIntentOpts,
): PaymentIntent {
  const { amount, currency } = cartTotal(cart, opts.minorUnitsPerMajor);
  return {
    id: opts.id,
    payee: cart.contents.merchant_name,
    payeeClass: opts.payeeClass,
    amount,
    currency,
    rail: opts.rail,
    rationale: opts.rationale,
    createdAt: opts.createdAt,
  };
}

// --- Gate seam ---------------------------------------------------------------

/** Derive an AgentWorth PaymentIntent from an AP2 CartMandate and run it through the gate.
 * The gate is the policy engine behind AP2 authorization — it decides
 * auto_execute / confirm_operator / block. Returns both the derived intent and the
 * decision so the caller can act on (and audit) exactly what was evaluated. */
export function gateAp2Cart(
  _deps: { config?: GateConfig },
  cart: CartMandate,
  ctx: GateContext,
  opts: CartMandateToIntentOpts,
): { intent: PaymentIntent; decision: GateDecision } {
  const intent = cartMandateToIntent(cart, opts);
  const decision = evaluateGate(intent, ctx);
  return { intent, decision };
}

// --- CartMandate verification (best-effort, documented) ----------------------

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

export interface VerifyCartMandateOpts {
  /** Resolve the merchant's verification key from the JWT header / iss claim. */
  resolveKey: (h: {
    kid?: string;
    alg?: string;
    iss?: string;
  }) => KeyObject | undefined | Promise<KeyObject | undefined>;
  /** Clock (ms epoch). Injected for deterministic tests. Default: Date.now. */
  now?: () => number;
  /** Override the canonicalizer used to recompute cart_hash. Default: JCS. */
  canonicalize?: (v: unknown) => string;
  /** Clock skew (seconds) tolerated on exp/iat. Default: 30. */
  toleranceSeconds?: number;
}

export interface VerifyCartMandateResult {
  ok: boolean;
  reason?: string;
  /** Whether the recomputed cart_hash matched the signed `cart_hash` claim. */
  cartHashOk: boolean;
  claims?: Record<string, unknown>;
}

function b64urlToBuffer(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function b64urlJson<T>(s: string): T | undefined {
  try {
    return JSON.parse(b64urlToBuffer(s).toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Map a JWT `alg` to the node:crypto digest/null for `verify`. EdDSA uses a null
 * algorithm; ES256 → SHA-256; RS256 → RSA-SHA256. Returns undefined for unknown. */
function algToDigest(alg: string | undefined): { digest: string | null } | undefined {
  switch (alg) {
    case "EdDSA":
      return { digest: null };
    case "ES256":
      return { digest: "sha256" };
    case "RS256":
      return { digest: "sha256" };
    default:
      return undefined;
  }
}

/** Best-effort verify a CartMandate's merchant_authorization JWT:
 *  1. parse header/payload/sig, read alg/kid/iss,
 *  2. resolve the merchant key and verify the signature (EdDSA / ES256 / RS256),
 *  3. enforce the exp/iat window,
 *  4. recompute cart_hash over JCS(CartContents) and compare to the claim.
 * An unsigned cart (null merchant_authorization) is `{ok:false}` with cartHashOk
 * false — AP2 leaves merchant_authorization optional; AgentWorth treats unsigned as
 * unverified, never authorized. */
export async function verifyCartMandate(
  cart: CartMandate,
  opts: VerifyCartMandateOpts,
): Promise<VerifyCartMandateResult> {
  const jwt = cart.merchant_authorization;
  if (!jwt) {
    return { ok: false, reason: "unsigned cart (no merchant_authorization)", cartHashOk: false };
  }

  const parts = jwt.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "merchant_authorization is not a compact JWS", cartHashOk: false };
  }
  const [headerB64, payloadB64, sigB64] = parts;
  const header = b64urlJson<JwtHeader>(headerB64);
  const claims = b64urlJson<Record<string, unknown>>(payloadB64);
  if (!header || !claims) {
    return { ok: false, reason: "malformed JWT header or payload", cartHashOk: false };
  }

  // cart_hash check is independent of signature validity — compute it regardless.
  const canon = opts.canonicalize ?? canonicalize;
  const expectedHash = cartHash(cart.contents, canon);
  const cartHashOk = claims.cart_hash === expectedHash;

  const digest = algToDigest(header.alg);
  if (!digest) {
    return {
      ok: false,
      reason: `unsupported alg "${header.alg ?? "none"}"`,
      cartHashOk,
      claims,
    };
  }

  const now = opts.now ?? Date.now;
  const tolerance = opts.toleranceSeconds ?? 30;
  const nowSec = Math.floor(now() / 1000);
  if (typeof claims.exp === "number" && nowSec - tolerance > claims.exp) {
    return { ok: false, reason: "merchant_authorization expired", cartHashOk, claims };
  }
  if (typeof claims.iat === "number" && nowSec + tolerance < claims.iat) {
    return { ok: false, reason: "merchant_authorization issued in the future", cartHashOk, claims };
  }

  const key = await opts.resolveKey({
    kid: header.kid,
    alg: header.alg,
    iss: typeof claims.iss === "string" ? claims.iss : undefined,
  });
  if (!key) {
    return { ok: false, reason: "merchant key not resolved", cartHashOk, claims };
  }

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
  const sig = b64urlToBuffer(sigB64);
  let sigOk = false;
  try {
    sigOk = nodeVerify(digest.digest, signingInput, key, sig);
  } catch {
    sigOk = false;
  }
  if (!sigOk) {
    return { ok: false, reason: "merchant signature did not verify", cartHashOk, claims };
  }

  if (!cartHashOk) {
    return { ok: false, reason: "cart_hash does not match CartContents", cartHashOk, claims };
  }

  return { ok: true, cartHashOk, claims };
}

// --- PaymentMandate structural binding ---------------------------------------

export interface VerifyPaymentBindingOpts {
  /** Override the canonicalizer. Default: JCS. */
  canonicalize?: (v: unknown) => string;
  /** Override the hash over canonical JSON. Default: SHA-256 hex. */
  hash?: (s: string) => string;
}

export interface VerifyPaymentBindingResult {
  ok: boolean;
  reason?: string;
}

/** Decode the KB-JWT's `transaction_data` array from a PaymentMandate's
 * user_authorization (best-effort). The VP is `<issuer-jwt>~<disclosure>*~<kb-jwt>`;
 * the KB-JWT is the last `~`-segment, a compact JWS whose payload carries
 * `transaction_data`. Returns the array of hash strings, or undefined. */
function readTransactionData(userAuth: string | null | undefined): string[] | undefined {
  if (!userAuth) return undefined;
  const segments = userAuth.split("~").filter((s) => s.length > 0);
  const kbJwt = segments[segments.length - 1];
  if (!kbJwt) return undefined;
  const parts = kbJwt.split(".");
  if (parts.length !== 3) return undefined;
  const payload = b64urlJson<{ transaction_data?: unknown }>(parts[1]);
  const td = payload?.transaction_data;
  if (!Array.isArray(td)) return undefined;
  return td.filter((x): x is string => typeof x === "string");
}

/** STRUCTURAL binding check between a PaymentMandate and the CartMandate it
 * settles. This does NOT verify the VP's issuer/holder signatures — that is a VC
 * concern delegated to a SD-JWT-VC verifier. It asserts:
 *  - the details-id linkage: payment_details_id === cart.contents...details.id,
 *  - the KB-JWT transaction_data contains hash(CartMandate) AND
 *    hash(PaymentMandateContents).
 * Returns ok only when both the id linkage and both hashes are present. */
export function verifyPaymentMandateBinding(
  pm: PaymentMandate,
  cart: CartMandate,
  opts: VerifyPaymentBindingOpts = {},
): VerifyPaymentBindingResult {
  const canon = opts.canonicalize ?? canonicalize;
  const hash = opts.hash ?? sha256Hex;

  const cartDetailsId = cart.contents.payment_request.details.id;
  if (pm.payment_mandate_contents.payment_details_id !== cartDetailsId) {
    return {
      ok: false,
      reason: `payment_details_id "${pm.payment_mandate_contents.payment_details_id}" does not match cart details id "${cartDetailsId}"`,
    };
  }

  const td = readTransactionData(pm.user_authorization);
  if (!td) {
    return { ok: false, reason: "no transaction_data in user_authorization KB-JWT" };
  }

  const cartHashValue = hash(canon(cart));
  const pmcHashValue = hash(canon(pm.payment_mandate_contents));
  if (!td.includes(cartHashValue)) {
    return { ok: false, reason: "transaction_data missing CartMandate hash" };
  }
  if (!td.includes(pmcHashValue)) {
    return { ok: false, reason: "transaction_data missing PaymentMandateContents hash" };
  }

  return { ok: true };
}

// --- A2A tie-in (AgentCard extension + DataPart pack/unpack) ------------------

export interface Ap2AgentCardExtension {
  uri: string;
  description?: string;
  required?: boolean;
  params: { roles: string[] };
}

/** Build the AP2 AgentCard capability extension declaring this agent's roles. */
export function ap2AgentCardExtension(
  roles: Ap2Role[],
  opts: { required?: boolean; description?: string } = {},
): Ap2AgentCardExtension {
  return {
    uri: AP2_EXTENSION_URI,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    ...(opts.required !== undefined ? { required: opts.required } : {}),
    params: { roles },
  };
}

export interface Ap2DataPart {
  kind: "data";
  data: Record<string, unknown>;
}

/** Pack a mandate into an A2A DataPart under its AP2 key. */
export function toAp2DataPart(
  kind: "intent",
  mandate: IntentMandate,
): Ap2DataPart;
export function toAp2DataPart(kind: "cart", mandate: CartMandate): Ap2DataPart;
export function toAp2DataPart(kind: "payment", mandate: PaymentMandate): Ap2DataPart;
export function toAp2DataPart(
  kind: "intent" | "cart" | "payment",
  mandate: IntentMandate | CartMandate | PaymentMandate,
): Ap2DataPart {
  return { kind: "data", data: { [AP2_DATA_KEYS[kind]]: mandate } };
}

export interface A2AMessage {
  parts?: Array<{ kind?: string; data?: Record<string, unknown> }>;
}

export interface ReadAp2MandatesResult {
  intent?: IntentMandate;
  cart?: CartMandate;
  payment?: PaymentMandate;
}

/** Extract AP2 mandates from an A2A Message's DataParts by their fixed keys. The
 * last DataPart carrying a given key wins. */
export function readAp2Mandates(message: A2AMessage): ReadAp2MandatesResult {
  const out: ReadAp2MandatesResult = {};
  for (const part of message.parts ?? []) {
    const data = part.data;
    if (!data) continue;
    if (data[AP2_DATA_KEYS.intent] !== undefined) {
      out.intent = data[AP2_DATA_KEYS.intent] as IntentMandate;
    }
    if (data[AP2_DATA_KEYS.cart] !== undefined) {
      out.cart = data[AP2_DATA_KEYS.cart] as CartMandate;
    }
    if (data[AP2_DATA_KEYS.payment] !== undefined) {
      out.payment = data[AP2_DATA_KEYS.payment] as PaymentMandate;
    }
  }
  return out;
}
