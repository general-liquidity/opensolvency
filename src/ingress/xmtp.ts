// XMTP ingress — a second transport alongside the HTTP ingress. An agent or
// counterparty messages a payment request over XMTP (decentralized, MLS-encrypted
// agent/wallet messaging); it runs through the SAME executor/gate. XMTP moves no
// money — it carries the *request*; settlement stays on the rail the gate governs.
//
// The XMTP sender is cryptographically identified (wallet/inbox), so we treat
// inbound requests as `signed` attestation — the agent-identity layer can upgrade
// that to `registry_attested`. The live XMTP client (needs a wallet key + a
// persistent local DB, max 10 installations/inbox) is injected; this stays pure.

import { PaymentIntentDraftSchema } from "../agent/schema.ts";
import type { Executor } from "../core/executor.ts";
import type { PaymentIntent } from "../core/types.ts";

export interface XmtpMessageCtx {
  content: unknown; // decoded message content (custom codec / wallet-send-calls / JSON)
  senderInboxId: string;
  /** XMTP consent state; false = denied → ignore. */
  isAllowed?: boolean;
  sendText(text: string): Promise<void> | void;
}

export interface XmtpIngressClient {
  on(event: "message", handler: (ctx: XmtpMessageCtx) => Promise<void> | void): void;
  start(): Promise<void> | void;
}

export interface XmtpIngressDeps {
  client: XmtpIngressClient;
  executor: Executor;
  clock: () => string;
  newId: () => string;
}

export function createXmtpIngress(deps: XmtpIngressDeps): { start(): Promise<void> } {
  deps.client.on("message", async (ctx) => {
    if (ctx.isAllowed === false) return; // honor XMTP consent (spam-gate)

    let draft;
    try {
      const raw = typeof ctx.content === "string" ? JSON.parse(ctx.content) : ctx.content;
      draft = PaymentIntentDraftSchema.parse(raw);
    } catch {
      await ctx.sendText("ignored: not a valid payment request");
      return;
    }

    const intent: PaymentIntent = {
      ...draft,
      id: deps.newId(),
      createdAt: deps.clock(),
    };
    const result = await deps.executor.execute(intent, { attestation: "signed" });
    await ctx.sendText(`${result.status}: ${result.decision.reasons.join("; ")}`);
  });

  return {
    start: async () => {
      await deps.client.start();
    },
  };
}
