// JSON-RPC 2.0 interface — a low-latency, method-based embedding surface over the
// OpenSolvency SDK. This is the OPERATOR-SIDE API (the operator's own systems call
// it): unlike the MCP server (the untrusted-agent surface, gated `pay` + read-only),
// this exposes the full operator API including approve / revoke / kill. Put it on a
// trusted transport (loopback / authenticated socket), never the open internet.
//
// `handleJsonRpcCall` is the pure dispatcher; wrap it in a stdio or HTTP transport.
// Every money-moving method still routes through the gate inside the SDK — JSON-RPC
// adds reach, not authority.

import type { OpenSolvency, GrantMandateInput, PayInput } from "../sdk/index.ts";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function fail(id: JsonRpcRequest["id"], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

type Handler = (sdk: OpenSolvency, params: Record<string, unknown>) => unknown | Promise<unknown>;

/** The exposed method table. Money methods (`pay`, `approve`) route through the gate
 *  inside the SDK; read methods are side-effect-free. */
export const RPC_METHODS: Record<string, Handler> = {
  "mandate.grant": (sdk, p) => sdk.grantMandate(p as unknown as GrantMandateInput),
  "mandate.list": (sdk) => sdk.listMandates(),
  "mandate.revoke": (sdk, p) => {
    sdk.revokeMandate(String(p.id));
    return { revoked: String(p.id) };
  },
  pay: (sdk, p) => sdk.pay(p as unknown as PayInput),
  pending: (sdk) => sdk.pending(),
  approve: (sdk, p) =>
    sdk.approve(String(p.intentId), { rationale: String(p.rationale ?? ""), ack: p.ack === true }),
  refund: (sdk, p) =>
    sdk.refund(String(p.intentId), { amountMinor: p.amountMinor as number | undefined, reason: p.reason as string | undefined }),
  "audit.verify": (sdk) => sdk.verifyAudit(),
  status: (sdk) => ({
    killSwitch: sdk.isKillSwitchEngaged(),
    circuitBreaker: sdk.isCircuitBreakerOpen(),
    consecutiveFailures: sdk.consecutiveFailures(),
  }),
};

/** Dispatch one JSON-RPC request against an SDK instance. Notifications (no `id`)
 *  still execute but no response is meaningful to the caller; we return one anyway
 *  for the transport to drop if it likes. Pure w.r.t. the protocol layer. */
export async function handleJsonRpcCall(
  sdk: OpenSolvency,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return fail(req.id ?? null, -32600, "invalid request");
  }
  const handler = RPC_METHODS[req.method];
  if (!handler) return fail(req.id, -32601, `method not found: ${req.method}`);
  const params =
    req.params && typeof req.params === "object" ? (req.params as Record<string, unknown>) : {};
  try {
    return ok(req.id, await handler(sdk, params));
  } catch (e) {
    return fail(req.id, -32603, e instanceof Error ? e.message : String(e));
  }
}
