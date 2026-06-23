// A LOCAL FORWARD HTTP PROXY that governs an agent's x402 spend transparently.
//
// The point: ANY agent that pays for things — a CLI coding agent, an HTTP client
// hitting an x402 paywall — points its outbound traffic at this proxy and has its
// spend governed WITHOUT integrating with OpenSolvency at all. The agent never
// knew it had a spend to govern; the gate governs it anyway.
//
// The flow (the x402 protocol, intercepted):
//   1. The agent makes a normal request through the proxy.
//   2. The proxy forwards it upstream. If the upstream answers 200/anything-else,
//      the proxy is a passthrough — it adds no authority.
//   3. If the upstream answers `402 Payment Required` with an x402 challenge (an
//      `accepts` list of PaymentRequirements), the proxy does NOT auto-pay. It
//      turns the cheapest acceptable requirement into a PaymentIntent and runs it
//      THROUGH THE EXECUTOR — i.e. through the gate. The gate decision is the
//      single source of truth:
//        • auto_execute  → the executor settles (mints the X-PAYMENT proof), the
//          proxy retries the original request WITH that proof, and returns the
//          upstream's now-paid response to the agent.
//        • confirm_operator → 402 back to the agent with the pending intent id and
//          the operator-approval status (a novel payee / no mandate is never
//          silently paid).
//        • block → 403 back to the agent (over-cap / deny-list / expired mandate).
//
// `handleChallenge` is the pure, testable decision core. `createX402Proxy` wires
// it to an upstream fetch + a proof builder. `createX402ProxyServer` is the thin
// node:http forward-proxy wrapper. Nothing here touches a real network in tests:
// the upstream `fetch` and the executor's rail are both injectable.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Executor, ExecuteResult } from "../core/executor.ts";
import type { PaymentIntent, RailKind } from "../core/types.ts";

/** One x402 payment requirement, as a resource server lists it in a 402 body. */
export interface X402Requirement {
  scheme: string; // e.g. "exact"
  network: string; // e.g. "base", "base-sepolia", "solana"
  asset: string; // token contract / mint (its symbol drives the intent currency)
  payTo: string; // the payee (stable id we govern against)
  maxAmountRequired: string; // minor-units, decimal string (x402 spec uses strings)
  resource?: string;
  description?: string;
}

/** The x402 challenge body a resource server returns alongside a 402. */
export interface X402Challenge {
  x402Version?: number;
  accepts: X402Requirement[];
  error?: string;
  resource?: string;
}

/** How a chosen requirement maps onto an OpenSolvency PaymentIntent. The proxy
 * governs the SAME structured numbers the gate decides on, derived from the
 * machine-readable challenge — not from any agent-supplied text. */
export interface ChallengeContext {
  /** Mints the intent id (deterministic in tests, random in prod). */
  newId: () => string;
  /** Injected ISO clock — the kernel never reads the wall clock. */
  clock: () => string;
  /** Rail kind these x402 settlements use. x402 is on-chain stablecoin. */
  rail?: RailKind;
  /** Map an x402 asset (contract/mint) to a currency code. Defaults to USDC. */
  currencyOf?: (req: X402Requirement) => string;
  /** Classify the payee for mandate scope matching. Defaults to "x402-service". */
  payeeClassOf?: (req: X402Requirement) => string;
  /** Networks this operator's wallet can settle on. Undefined = accept any. */
  networks?: string[];
}

export type ChallengeOutcome = "settle" | "route_to_operator" | "block" | "no_requirement";

/** The result of routing an x402 challenge through the gate. */
export interface ChallengeDecision {
  outcome: ChallengeOutcome;
  /** The requirement the proxy selected (cheapest acceptable), if any. */
  requirement: X402Requirement | null;
  /** The intent the gate decided on, if a requirement was selected. */
  intent: PaymentIntent | null;
  /** The full executor result (gate decision + receipt), if the intent was run. */
  result: ExecuteResult | null;
  /** Human-readable reasons, surfaced to the agent. */
  reasons: string[];
}

const USDC_MINOR = "USDC";

/** Select the cheapest requirement on an acceptable network. The gate enforces the
 * caps; the proxy just picks the least-cost option the operator's wallet can pay. */
export function selectRequirement(
  accepts: X402Requirement[],
  networks?: string[],
): X402Requirement | null {
  const eligible = accepts.filter((r) => {
    if (networks && !networks.includes(r.network)) return false;
    return Number.isFinite(Number(r.maxAmountRequired));
  });
  if (eligible.length === 0) return null;
  return eligible.reduce((best, r) =>
    Number(r.maxAmountRequired) < Number(best.maxAmountRequired) ? r : best,
  );
}

/** Build the PaymentIntent the gate will decide on, from a chosen requirement. */
function intentFor(req: X402Requirement, ctx: ChallengeContext): PaymentIntent {
  const currency = ctx.currencyOf?.(req) ?? USDC_MINOR;
  const payeeClass = ctx.payeeClassOf?.(req) ?? "x402-service";
  return {
    id: ctx.newId(),
    payee: req.payTo,
    payeeClass,
    amount: Math.trunc(Number(req.maxAmountRequired)),
    currency,
    rail: ctx.rail ?? "onchain",
    rationale:
      `x402 paywall: ${req.description ?? req.resource ?? "resource"} ` +
      `on ${req.network} (${req.scheme})`,
    createdAt: ctx.clock(),
  };
}

/**
 * THE PURE DECISION CORE. Given an x402 challenge, decide settle-vs-route-vs-block
 * by running the selected requirement through the executor — i.e. through the gate.
 * The gate decision is the single source of truth; this function never pays around
 * it. No network here: the executor's rail does any settlement.
 */
export async function handleChallenge(
  challenge: X402Challenge,
  executor: Executor,
  ctx: ChallengeContext,
): Promise<ChallengeDecision> {
  const requirement = selectRequirement(challenge.accepts, ctx.networks);
  if (!requirement) {
    return {
      outcome: "no_requirement",
      requirement: null,
      intent: null,
      result: null,
      reasons: ["no x402 requirement on an acceptable network"],
    };
  }

  const intent = intentFor(requirement, ctx);
  const result = await executor.execute(intent);

  const outcome: ChallengeOutcome =
    result.status === "settled"
      ? "settle"
      : result.status === "pending"
        ? "route_to_operator"
        : "block"; // blocked OR failed → do not let the request through

  return {
    outcome,
    requirement,
    intent,
    result,
    reasons: result.decision.reasons,
  };
}

// --- HTTP proxy wiring -------------------------------------------------------

/** A minimal HTTP exchange the proxy forwards. Transport-agnostic so the core is
 * testable with an injected upstream `fetch`, no real sockets required. */
export interface ProxyRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Performs the upstream round-trip. Injected so tests use an in-process server or
 * a fake; production wires it to node's http(s) or global fetch. The `paymentProof`
 * (an X-PAYMENT header value), when present, is attached to the retried request. */
export type UpstreamFetch = (
  req: ProxyRequest,
  paymentProof?: string,
) => Promise<ProxyResponse>;

/** Turn a settled receipt into the X-PAYMENT proof header the resource server
 * expects on the retry. Injected because the real proof comes from the wallet /
 * facilitator that settled; in tests it's a deterministic stub. Defaults to the
 * settlement provider reference (the on-chain tx ref), which is what a verifier
 * checks. */
export type PaymentProofBuilder = (result: ExecuteResult) => string;

export interface X402ProxyDeps {
  executor: Executor;
  upstream: UpstreamFetch;
  ctx: ChallengeContext;
  /** Defaults to the settled receipt's providerRef. */
  buildProof?: PaymentProofBuilder;
}

function defaultProof(result: ExecuteResult): string {
  return result.receipt?.providerRef ?? "";
}

function parseChallenge(res: ProxyResponse): X402Challenge | null {
  try {
    const parsed = JSON.parse(res.body) as Partial<X402Challenge>;
    if (parsed && Array.isArray(parsed.accepts)) {
      return { accepts: parsed.accepts, x402Version: parsed.x402Version };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * The forward proxy. `forward(req)` is the whole governed round-trip:
 *   passthrough → on a 402, route the challenge through the gate → settle+retry,
 *   or hand the agent a 402 (pending) / 403 (blocked).
 */
export function createX402Proxy(deps: X402ProxyDeps) {
  const buildProof = deps.buildProof ?? defaultProof;

  async function forward(req: ProxyRequest): Promise<ProxyResponse> {
    const first = await deps.upstream(req);
    if (first.status !== 402) return first; // passthrough — proxy adds no authority

    const challenge = parseChallenge(first);
    if (!challenge) return first; // a 402 we don't understand — surface it unchanged

    const decision = await handleChallenge(challenge, deps.executor, deps.ctx);

    if (decision.outcome === "settle" && decision.result) {
      const proof = buildProof(decision.result);
      return deps.upstream(req, proof); // retry WITH the X-PAYMENT proof
    }

    const body = JSON.stringify({
      governed: true,
      outcome: decision.outcome,
      intentId: decision.intent?.id ?? null,
      reasons: decision.reasons,
    });

    if (decision.outcome === "route_to_operator") {
      // The agent gets a 402 back — payment is required and pending operator
      // approval. It can poll / re-issue once the operator confirms.
      return {
        status: 402,
        headers: { "content-type": "application/json", "x-opensolvency": "pending-operator" },
        body,
      };
    }

    // block / failed / no_requirement → refuse.
    return {
      status: 403,
      headers: { "content-type": "application/json", "x-opensolvency": "blocked" },
      body,
    };
  }

  return { forward };
}

export type X402Proxy = ReturnType<typeof createX402Proxy>;

/** The thin node:http forward-proxy server. An agent sets HTTP_PROXY to this and
 * its x402 spend is governed transparently. Bound to loopback by the caller. */
export function createX402ProxyServer(proxy: X402Proxy): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v.join(", ");
      }
      const proxyReq: ProxyRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers,
        body: body.length > 0 ? body : undefined,
      };
      void proxy.forward(proxyReq).then((out) => {
        res.writeHead(out.status, out.headers);
        res.end(out.body);
      });
    });
  });
}
