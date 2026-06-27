// AgentWorth as an MCP server — "make it accessible to agents" (Base MCP-style).
// Other agents (Claude, etc.) call these tools. The SECURITY BOUNDARY is the
// point: the MCP surface exposes only what an external agent should have — propose
// a payment (which still runs through the gate) and READ state. It deliberately
// does NOT expose operator controls (approve / kill / refund / amend): an external
// agent must never be able to approve its own pending payment or disarm the kill
// switch. Those stay operator-only (CLI). An MCP caller is an unverified external
// agent, so its `pay` proposals are gated with attestation "none" (higher risk).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RAIL_KINDS } from "../agent/schema.ts";
import { VERSION } from "../version.ts";
import type { Executor } from "../core/executor.ts";
import type { Store } from "../core/store.ts";
import type { AuditLog } from "../core/audit.ts";
import type { PaymentIntent } from "../core/types.ts";

export interface McpDeps {
  executor: Executor;
  store: Store;
  audit: AuditLog;
  clock: () => string;
  newId: () => string;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function createAgentWorthMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "agentworth", version: VERSION });

  // PROPOSE (gated) — the only money-touching tool; the gate still governs.
  server.registerTool(
    "pay",
    {
      description:
        "Propose a payment. It is evaluated by the governance gate against the " +
        "operator's mandates, caps, risk, and deny-list — you cannot bypass it. " +
        "Amounts are integer minor-units.",
      inputSchema: {
        payee: z.string(),
        payeeClass: z.string(),
        amount: z.number().int().positive(),
        currency: z.string(),
        rail: z.enum(RAIL_KINDS),
        rationale: z.string().min(10),
      },
    },
    async (args) => {
      const intent: PaymentIntent = { ...args, id: deps.newId(), createdAt: deps.clock() };
      const r = await deps.executor.execute(intent, { attestation: "none" });
      return text(
        `${r.status}: ${r.decision.reasons.join("; ")}` +
          (r.receipt ? ` (receipt ${r.receipt.id})` : ""),
      );
    },
  );

  // READ-ONLY tools.
  server.registerTool(
    "list_mandates",
    { description: "List the operator's active mandates.", inputSchema: {} },
    async () => {
      const ms = deps.store.listActiveMandates(deps.clock());
      return text(
        ms.length === 0
          ? "no active mandates"
          : ms
              .map(
                (m) =>
                  `${m.id} "${m.label}" ${m.currency} per-tx ${m.perTxCap} per-${m.period} ${m.perPeriodCap}`,
              )
              .join("\n"),
      );
    },
  );

  server.registerTool(
    "pending",
    { description: "List payments awaiting operator confirmation.", inputSchema: {} },
    async () => {
      const ps = deps.store.listPendingIntents();
      return text(
        ps.length === 0
          ? "none pending"
          : ps
              .map((s) => `${s.intent.id} ${s.intent.amount} ${s.intent.currency} → ${s.intent.payee}`)
              .join("\n"),
      );
    },
  );

  server.registerTool(
    "status",
    { description: "Kill switch + circuit breaker state.", inputSchema: {} },
    async () =>
      text(
        `kill switch: ${deps.executor.isKillSwitchEngaged() ? "ENGAGED" : "off"}; ` +
          `circuit breaker: ${deps.executor.isCircuitBreakerOpen() ? "OPEN" : "closed"}`,
      ),
  );

  server.registerTool(
    "audit_verify",
    { description: "Verify the signed audit chain's integrity.", inputSchema: {} },
    async () => {
      const v = deps.audit.verify();
      return text(
        v.valid
          ? `audit chain OK — ${deps.audit.entries().length} entries`
          : `audit chain INVALID at seq ${v.brokenAt}: ${v.reason}`,
      );
    },
  );

  return server;
}

export async function startMcpStdio(server: McpServer): Promise<void> {
  await server.connect(new StdioServerTransport());
}
