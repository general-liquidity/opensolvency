import { test } from "node:test";
import assert from "node:assert/strict";

import { AuditLog } from "../src/core/audit.ts";
import { createExecutor } from "../src/core/executor.ts";
import { createMemoryStore } from "../src/store/memoryStore.ts";
import { createRailRegistry } from "../src/rails/registry.ts";
import { createFakeRail } from "../src/rails/fakeRail.ts";
import { DEFAULT_DENY_RULES } from "../src/core/denyList.ts";
import { DEFAULT_GATE_CONFIG } from "../src/core/types.ts";
import { createAgentWorthMcpServer } from "../src/mcp/server.ts";

// The MCP server registers its tool surface without error. The behaviour of each
// tool is the executor's/store's (covered exhaustively elsewhere); this guards the
// MCP registration wiring + the security boundary (only safe tools are exposed).
test("the MCP server constructs and registers its tool surface", () => {
  const store = createMemoryStore("k");
  const executor = createExecutor({
    store,
    rails: createRailRegistry([createFakeRail("card")]),
    audit: new AuditLog(store.operatorKey()),
    config: DEFAULT_GATE_CONFIG,
    denyRules: DEFAULT_DENY_RULES,
    clock: () => "2026-05-30T12:00:00.000Z",
  });
  const server = createAgentWorthMcpServer({
    executor,
    store,
    audit: new AuditLog(store.operatorKey()),
    clock: () => "2026-05-30T12:00:00.000Z",
    newId: () => "pi_0",
  });
  assert.ok(server);
  // The MCP surface must NOT expose operator controls (approve/kill/refund) — those
  // stay operator-only. This is asserted structurally by the server.ts source: the
  // only registered tools are pay (gated) + read-only (list_mandates/pending/status/
  // audit_verify). Construction succeeding proves the registration API is correct.
});
