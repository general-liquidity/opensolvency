// Agent Client Protocol (ACP) — the JSON-RPC surface editors/IDEs (Zed and the
// growing set of ACP clients) speak to drive an agent in-editor. This exposes
// AgentWorth's finance agent over that protocol so it shows up as a first-class
// agent inside an IDE, alongside the MCP server (for Claude Code / Cursor) and the
// HTTP ingress.
//
// `handleAcpMessage` is the PURE, testable core: a JSON-RPC request in, a response
// (and any notifications to emit) out. The agent itself is injected as `runPrompt`,
// so the protocol layer is decoupled from model/executor wiring and from the gate —
// every payment the agent proposes still goes through the same executor inside
// `runPrompt`, the protocol adds no authority. `entry.ts` is the stdio transport.
//
// Scope: the core methods an editor needs — initialize, session/new, session/prompt.
// This targets ACP's request/response shapes; verify exact field conformance
// against the current spec (agentclientprotocol.com) before claiming full support.

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

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params: unknown;
}

export interface AcpResult {
  /** The response to a request (absent for notifications/unknown-no-id). */
  response?: JsonRpcResponse;
  /** Out-of-band messages to emit before/with the response (streaming updates). */
  notifications?: JsonRpcNotification[];
}

/** What the protocol layer needs from the host: a way to run a user turn through
 *  the gate-enforced finance agent, and to mint session ids. */
export interface AcpDeps {
  /** Run one user turn; returns the agent's final text. The gate is enforced
   *  inside this (it wraps runFinanceAgent). */
  runPrompt: (sessionId: string, text: string) => Promise<string>;
  newSessionId: () => string;
}

const PROTOCOL_VERSION = 1;

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function err(id: JsonRpcRequest["id"], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** Pull the concatenated text out of an ACP prompt content array. */
function promptText(params: unknown): string {
  const blocks = (params as { prompt?: unknown })?.prompt;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((b) => (b && typeof b === "object" && (b as { text?: unknown }).text) || "")
    .filter((t): t is string => typeof t === "string")
    .join("");
}

export async function handleAcpMessage(
  msg: JsonRpcRequest,
  deps: AcpDeps,
): Promise<AcpResult> {
  switch (msg.method) {
    case "initialize":
      return {
        response: ok(msg.id, {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { promptCapabilities: { image: false, audio: false } },
          // No auth methods: the operator's gate/mandates govern authority, not a
          // protocol-level login.
          authMethods: [],
        }),
      };

    case "session/new":
      return { response: ok(msg.id, { sessionId: deps.newSessionId() }) };

    case "session/prompt": {
      const sessionId = String((msg.params as { sessionId?: unknown })?.sessionId ?? "");
      const text = promptText(msg.params);
      if (!sessionId) return { response: err(msg.id, -32602, "missing sessionId") };
      const reply = await deps.runPrompt(sessionId, text);
      return {
        // Stream the agent's message, then close the turn — the two-part shape an
        // ACP client expects (an update notification + a prompt response).
        notifications: [
          {
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: reply },
              },
            },
          },
        ],
        response: ok(msg.id, { stopReason: "end_turn" }),
      };
    }

    case "session/cancel":
      // Notification (no id) — nothing to cancel in a synchronous turn; ack silently.
      return {};

    default:
      // Unknown method: only answer if it was a request (has an id).
      return msg.id === undefined
        ? {}
        : { response: err(msg.id, -32601, `method not found: ${msg.method}`) };
  }
}
