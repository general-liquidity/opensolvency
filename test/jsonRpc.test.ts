import test from "node:test";
import assert from "node:assert/strict";

import { AgentWorth } from "../src/sdk/index.ts";
import { handleJsonRpcCall, RPC_METHODS, type JsonRpcRequest } from "../src/rpc/jsonRpc.ts";

const NOW = "2026-06-24T12:00:00.000Z";
function sdk() {
  return new AgentWorth({ clock: () => NOW });
}
const call = (sdk: AgentWorth, method: string, params?: unknown, id: number | string = 1) =>
  handleJsonRpcCall(sdk, { jsonrpc: "2.0", id, method, params } as JsonRpcRequest);

test("grant a mandate then list it over JSON-RPC", async () => {
  const s = sdk();
  const granted = await call(s, "mandate.grant", {
    label: "groceries", scope: { kind: "class", value: "groceries" }, currency: "GBP",
    allowedRails: ["card"], perTxCap: 500_00, perPeriodCap: 1000_00, period: "week", expiresInDays: 30,
  });
  assert.ok((granted.result as { id: string }).id);
  const list = await call(s, "mandate.list");
  assert.equal((list.result as unknown[]).length, 1);
});

test("pay routes through the gate — over-cap is blocked", async () => {
  const s = sdk();
  await call(s, "mandate.grant", {
    label: "groceries", scope: { kind: "class", value: "groceries" }, currency: "GBP",
    allowedRails: ["card"], perTxCap: 500_00, perPeriodCap: 1000_00, period: "week", expiresInDays: 30,
  });
  const r = await call(s, "pay", {
    payee: "tesco", payeeClass: "groceries", amount: 600_00, currency: "GBP", rail: "card",
    rationale: "way over the cap",
  });
  assert.equal((r.result as { status: string }).status, "blocked");
});

test("status + audit.verify are exposed and read-only", async () => {
  const s = sdk();
  const st = await call(s, "status");
  assert.equal((st.result as { killSwitch: boolean }).killSwitch, false);
  const v = await call(s, "audit.verify");
  assert.equal((v.result as { valid: boolean }).valid, true);
});

test("unknown method → -32601; bad request → -32600", async () => {
  const s = sdk();
  const unknown = await call(s, "frobnicate");
  assert.equal(unknown.error?.code, -32601);
  const bad = await handleJsonRpcCall(s, { jsonrpc: "1.0" as never, id: 1, method: "status" });
  assert.equal(bad.error?.code, -32600);
});

test("a handler that throws surfaces as -32603, not a crash", async () => {
  const s = sdk();
  // approve a non-existent intent → SDK throws → JSON-RPC internal error
  const r = await call(s, "approve", { intentId: "nope", rationale: "x" });
  assert.equal(r.error?.code, -32603);
  assert.ok("pay" in RPC_METHODS && "approve" in RPC_METHODS);
});
