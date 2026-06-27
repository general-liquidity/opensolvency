#!/usr/bin/env node
// @general-liquidity/agentworth-mcp — the AgentWorth MCP server as a standalone
// npx-able package. Delegates to the main package's MCP entry; all logic lives
// there. Point AGENTWORTH_DB at the operator's store so the server sees their
// real mandates.
import { startAgentWorthMcp } from "@general-liquidity/agentworth/mcp";

startAgentWorthMcp().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
