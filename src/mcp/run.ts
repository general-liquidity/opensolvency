// Reusable MCP entry point. Composes the sqlite-backed runtime and serves the MCP
// server over stdio, so BOTH the bundled `agentworth mcp` CLI command and the
// standalone `@general-liquidity/agentworth-mcp` package launch the exact same
// gated surface. Exposed as the package subpath `@general-liquidity/agentworth/mcp`.

import { randomUUID } from "node:crypto";
import { AuditLog } from "../core/audit.ts";
import { createExecutor, type Executor } from "../core/executor.ts";
import { DEFAULT_GATE_CONFIG } from "../core/types.ts";
import { DEFAULT_DENY_RULES } from "../core/denyList.ts";
import { createSqliteStore } from "../store/sqliteStore.ts";
import { createRailRegistry } from "../rails/registry.ts";
import { createFakeRail } from "../rails/fakeRail.ts";
import { createAgentWorthMcpServer, startMcpStdio } from "./server.ts";
import { webhookNotifier } from "../notify/notifier.ts";
import { otlpTracer } from "../obs/otlpTracer.ts";
import type { Store } from "../core/store.ts";
import type { Attestation } from "../core/types.ts";

export interface McpRuntime {
  store: Store;
  executor: Executor;
  audit: AuditLog;
  clock: () => string;
  resolveAttestation?: () => Promise<Attestation> | Attestation;
}

/** Build the persistent sqlite-backed runtime an MCP server needs. The DB path is
 *  `AGENTWORTH_DB` (default `agentworth.db`) — point it at the operator's store
 *  so the server sees their real mandates. */
export function buildSqliteRuntime(
  dbPath = process.env.AGENTWORTH_DB ?? "agentworth.db",
): McpRuntime {
  const store = createSqliteStore(dbPath);
  const audit = new AuditLog(store.operatorKey(), store.loadAudit());
  const rails =
    process.env.AGENTWORTH_SIMULATION === "1"
      ? createRailRegistry([
          createFakeRail("card"),
          createFakeRail("checkout"),
          createFakeRail("onchain"),
        ])
      : createRailRegistry([]);
  const clock = () => new Date().toISOString();
  const notifierUrl = process.env.AGENTWORTH_NOTIFY_WEBHOOK_URL;
  const otlpEndpoint = process.env.AGENTWORTH_OTLP_ENDPOINT;
  const executor = createExecutor({
    store,
    rails,
    audit,
    config: DEFAULT_GATE_CONFIG,
    denyRules: DEFAULT_DENY_RULES,
    clock,
    notifier: notifierUrl
      ? webhookNotifier({
          url: notifierUrl,
          token: process.env.AGENTWORTH_NOTIFY_WEBHOOK_TOKEN,
          fetch: (url, init) => fetch(url, init),
        })
      : undefined,
    tracer: otlpEndpoint
      ? otlpTracer({
          endpoint: otlpEndpoint,
          fetch: (url, init) => fetch(url, init),
        })
      : undefined,
  });
  return { store, executor, audit, clock };
}

/** Serve the AgentWorth MCP surface over stdio. Pass an existing runtime (the
 *  CLI does, to reuse its open store) or omit it to build a fresh sqlite runtime
 *  (the standalone `-mcp` package). Exposes ONLY the safe surface: a gated `pay`
 *  plus read-only tools — operator controls are never exposed. */
export async function startAgentWorthMcp(runtime?: McpRuntime): Promise<void> {
  const { store, executor, audit, clock, resolveAttestation } =
    runtime ?? buildSqliteRuntime();
  const server = createAgentWorthMcpServer({
    executor,
    store,
    audit,
    clock,
    resolveAttestation,
    newId: () => `pi_${randomUUID().slice(0, 8)}`,
  });
  await startMcpStdio(server);
}

export { createAgentWorthMcpServer } from "./server.ts";
