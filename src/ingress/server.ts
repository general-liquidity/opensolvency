// Event ingress — the always-on face of the gate. An external system or agent
// submits a payment request over HTTP; it runs through the SAME executor (and
// therefore the same gate) as the CLI. This surface is safe precisely BECAUSE of
// the gate: an inbound request with no covering mandate routes to operator
// confirmation (202), an over-cap/deny-listed one is blocked (403), and only a
// mandate-covered, under-cap, low-risk request auto-settles (200). The HTTP layer
// adds no new authority — it's just another transport into the invariant.
//
// `handleIngress` is the pure, testable core; `createIngressServer` is the thin
// node:http wrapper, bound to loopback by default (OpenClaw's posture).

import { createServer, type Server } from "node:http";
import { PaymentIntentDraftSchema } from "../agent/schema.ts";
import { authorizeIngress } from "./auth.ts";
import { buildOpenApiDocument } from "./openapi.ts";
import { replayIfSeen, rememberKey } from "./idempotency.ts";
import {
  buildAndSignDisclosure,
  loadOrCreateAgentKey,
  respondToChallenge,
  parseSignedDisclosure,
  evaluateDisclosure,
  verifyTiered,
} from "../disclosure/index.ts";
import type { Challenge, VerificationPolicy, VerificationCache } from "../disclosure/index.ts";
import type { RateLimiter } from "./rateLimit.ts";
import type { Executor } from "../core/executor.ts";
import type { Store } from "../core/store.ts";
import type { AuditLog } from "../core/audit.ts";
import type { PaymentIntent } from "../core/types.ts";

const GENESIS = "0".repeat(64);

/** Verifiable Agency: when set, the ingress serves the agent's signed disclosure and
 *  answers live verification challenges, so a counterparty can vet this agent before
 *  transacting. The disclosure is public by design (no auth). */
export interface DisclosureIngressConfig {
  audit: AuditLog;
  operator: {
    id: string;
    deniabilityBoundary: string;
    attestation?: { scheme: "AIP" | "VisaTAP" | "ERC8004" | "none"; level: "none" | "signed" | "registry_attested"; evidence?: string };
  };
  systemPrompt?: string;
  /** the policy this node applies when offering verifier-as-a-service (POST
   *  /verify-disclosure). `now` is filled from the server clock per request. */
  verifierPolicy?: Omit<VerificationPolicy, "now">;
  /** optional validity-window cache for the verifier-as-a-service fast path */
  verificationCache?: VerificationCache;
}

/** Default cap on a request body — a payment intent is tiny; reject anything large. */
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export interface IngressDeps {
  executor: Executor;
  clock: () => string;
  newId: () => string;
  /** Configured bearer token; when set, non-/health requests must present it.
   * When undefined the surface is open (loopback dev posture). */
  ingressToken?: () => string | undefined;
  /** Version stamped into the served OpenAPI document. */
  version?: string;
  /** Store, used to dedupe by Idempotency-Key (a retried POST settles once). */
  store?: Store;
  /** Per-IP rate limiter for the node:http wrapper (transport abuse guard). */
  rateLimiter?: RateLimiter;
  /** Max request body size in bytes (default 64 KiB). */
  maxBodyBytes?: number;
  /** Verifiable Agency disclosure surface (requires `store` for the signing key). */
  disclosure?: DisclosureIngressConfig;
}

export interface IngressResponse {
  status: number;
  body: unknown;
}

export async function handleIngress(
  method: string,
  path: string,
  rawBody: string,
  deps: IngressDeps,
  authHeader?: string,
  idempotencyKey?: string,
): Promise<IngressResponse> {
  // Transport auth runs before anything but liveness. The gate still decides every
  // payment; this only stops unauthenticated callers reaching the transport at all.
  const auth = authorizeIngress(path, authHeader, deps.ingressToken?.());
  if (!auth.ok) return { status: auth.status ?? 401, body: auth.body };

  if (method === "GET" && path === "/health") {
    return { status: 200, body: { ok: true } };
  }
  if (method === "GET" && path === "/ready") {
    // Readiness: the in-process gate responds (distinct from /health = process up).
    // Surfaces halt state so a load balancer can see it, but stays 200-ready —
    // kill/breaker are policy states, not unreadiness.
    return {
      status: 200,
      body: {
        ready: true,
        killSwitch: deps.executor.isKillSwitchEngaged(),
        circuitBreaker: deps.executor.isCircuitBreakerOpen(),
      },
    };
  }
  if (method === "GET" && path === "/openapi.json") {
    return { status: 200, body: buildOpenApiDocument(deps.version ?? "0.0.0") };
  }

  // ── Verifiable Agency: the disclosure surface (public — a counterparty fetches
  // this to vet the agent before transacting). ───────────────────────────────
  if (deps.disclosure && deps.store) {
    if (method === "GET" && path === "/.well-known/agent-disclosure") {
      const signed = buildAndSignDisclosure({
        store: deps.store,
        audit: deps.disclosure.audit,
        agentKey: loadOrCreateAgentKey(deps.store),
        systemPrompt: deps.disclosure.systemPrompt ?? "AgentWorth spending agent.",
        operator: deps.disclosure.operator,
        now: deps.clock(),
        nonce: deps.newId(),
      });
      return { status: 200, body: signed };
    }
    if (method === "POST" && path === "/agent-disclosure/respond") {
      // A verifier's live challenge: sign the nonce bound to the current audit head,
      // proving live key possession + history currency (defeats replay).
      let challenge: Challenge;
      try {
        challenge = JSON.parse(rawBody) as Challenge;
        if (typeof challenge?.nonce !== "string") throw new Error("missing nonce");
      } catch {
        return { status: 400, body: { error: "invalid challenge" } };
      }
      const entries = deps.disclosure.audit.entries();
      const head = entries.length ? entries[entries.length - 1].hash : GENESIS;
      const response = respondToChallenge(challenge, loadOrCreateAgentKey(deps.store), head, deps.clock());
      return { status: 200, body: response };
    }
  }

  // Verifier-as-a-service: a counterparty POSTs a signed disclosure; this node
  // evaluates it against its own policy and returns a verdict. Makes verification
  // cheap for heterogeneous callers (the language clients) that don't implement
  // ed25519 themselves - the economic enabler. Tiered + cached when configured.
  if (deps.disclosure && method === "POST" && path === "/verify-disclosure") {
    let signed: ReturnType<typeof parseSignedDisclosure>;
    try {
      signed = parseSignedDisclosure(JSON.parse(rawBody));
    } catch (e) {
      return { status: 400, body: { error: "invalid disclosure", detail: e instanceof Error ? e.message : String(e) } };
    }
    const policy: VerificationPolicy = { ...(deps.disclosure.verifierPolicy ?? {}), now: deps.clock() };
    const tiered = deps.disclosure.verificationCache
      ? verifyTiered(deps.disclosure.verificationCache, signed, policy)
      : { verdict: evaluateDisclosure(signed, policy), tier: "fresh" as const };
    return {
      status: 200,
      body: {
        decision: tiered.verdict.decision,
        tier: tiered.tier,
        checks: tiered.verdict.checks,
        reasons: tiered.verdict.reasons,
        cost: tiered.verdict.cost,
      },
    };
  }

  if (method === "GET" && path === "/status") {
    return {
      status: 200,
      body: {
        killSwitch: deps.executor.isKillSwitchEngaged(),
        circuitBreaker: deps.executor.isCircuitBreakerOpen(),
        consecutiveFailures: deps.executor.consecutiveFailures(),
      },
    };
  }
  if (method === "POST" && path === "/payment-intent") {
    // Idempotency: a retry carrying a key we've already settled replays the prior
    // result without re-running the gate (the intent is created exactly once).
    if (idempotencyKey && deps.store) {
      const replay = replayIfSeen(deps.store, idempotencyKey);
      if (replay) return replay;
    }
    let draft: ReturnType<typeof PaymentIntentDraftSchema.parse>;
    try {
      draft = PaymentIntentDraftSchema.parse(JSON.parse(rawBody));
    } catch {
      return { status: 400, body: { error: "invalid payment-intent" } };
    }
    const intent: PaymentIntent = {
      ...draft,
      id: deps.newId(),
      createdAt: deps.clock(),
    };
    const result = await deps.executor.execute(intent);
    if (idempotencyKey && deps.store) rememberKey(deps.store, idempotencyKey, result.intentId);
    const status =
      result.status === "settled"
        ? 200
        : result.status === "pending"
          ? 202 // accepted, awaiting operator confirmation
          : result.status === "failed"
            ? 502
            : 403; // blocked
    return {
      status,
      body: {
        intentId: result.intentId,
        outcome: result.status,
        reasons: result.decision.reasons,
        receiptId: result.receipt?.id ?? null,
        verified: result.verified,
      },
    };
  }
  return { status: 404, body: { error: "not found" } };
}

export function createIngressServer(
  deps: IngressDeps,
): Server {
  const maxBody = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const send = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  return createServer((req, res) => {
    // Per-IP rate limit (transport abuse guard) — the gate is still the authority.
    if (deps.rateLimiter) {
      const ip = req.socket.remoteAddress ?? "unknown";
      const rl = deps.rateLimiter.check(ip);
      if (!rl.ok) {
        res.setHeader("retry-after", Math.ceil((rl.retryAfterMs ?? 1000) / 1000));
        send(res, 429, { error: "rate limit exceeded" });
        return;
      }
    }

    let body = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body) > maxBody) {
        tooLarge = true;
        send(res, 413, { error: "payload too large" });
        req.destroy();
      }
    });
    req.on("end", () => {
      if (tooLarge) return;
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      const authHeader = req.headers.authorization;
      const idemKey = req.headers["idempotency-key"];
      const idempotencyKey = Array.isArray(idemKey) ? idemKey[0] : idemKey;
      void handleIngress(req.method ?? "GET", path, body, deps, authHeader, idempotencyKey).then(
        (out) => send(res, out.status, out.body),
      );
    });
  });
}
