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
import type { Executor } from "../core/executor.ts";
import type { PaymentIntent } from "../core/types.ts";

export interface IngressDeps {
  executor: Executor;
  clock: () => string;
  newId: () => string;
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
): Promise<IngressResponse> {
  if (method === "GET" && path === "/health") {
    return { status: 200, body: { ok: true } };
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
    let draft;
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
  return createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleIngress(req.method ?? "GET", path, body, deps).then((out) => {
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(JSON.stringify(out.body));
      });
    });
  });
}
