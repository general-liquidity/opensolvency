# Surfaces

One gate, reached from everywhere agents live. None of these adds authority — each
is a transport into the invariant.

| Surface | Get it | What it is |
|---|---|---|
| **TypeScript SDK** | `import { AgentWorth }` | The in-process façade — grant mandates, `pay()` through the gate, approve, verify the audit chain. |
| **CLI** | `agentworth …` | `init` / `mandate` / `pay` / `agent` / `finance` / `approve` / `kill` / `audit` / `serve` / `benchmark`. |
| **MCP** | `npx -y @general-liquidity/agentworth-mcp` | An MCP server — Claude Code / Cursor call the gated `pay` + read-only tools. |
| **ACP** | `agentworth acp` | An Agent Client Protocol surface — editors/IDEs drive the agent in-editor. |
| **HTTP** | `agentworth serve` | The ingress — same gate over HTTP, OpenAPI 3.1 at `/openapi.json`, bearer-token auth, idempotency keys, rate limiting. |
| **JSON-RPC** | `handleJsonRpcCall` | The operator-side method API for low-latency embedding. |
| **Python / Go** | `clients/` | Dependency-light REST clients over the ingress, for non-TS hosts. |

```ts
import { AgentWorth } from "@general-liquidity/agentworth";

const os = new AgentWorth();
os.grantMandate({ /* … */ });
await os.pay({ payee: "tesco", amount: 80_00, currency: "GBP", rail: "card",
               rationale: "the weekly grocery shop" });
os.verifyAudit().valid;   // true
```

## Operator vs agent surfaces

The **MCP** server is the *untrusted-agent* surface: a gated `pay` plus read-only
tools — operator controls (approve / kill / refund) are deliberately not exposed.
The **JSON-RPC** interface is the *operator-side* surface and exposes the full API;
keep it on a trusted transport.
