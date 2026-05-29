import { test } from "node:test";
import assert from "node:assert/strict";

import { AuditLog } from "../src/core/audit.ts";
import { createExecutor } from "../src/core/executor.ts";
import { createMemoryStore } from "../src/store/memoryStore.ts";
import { createRailRegistry } from "../src/rails/registry.ts";
import { createFakeRail } from "../src/rails/fakeRail.ts";
import { DEFAULT_DENY_RULES } from "../src/core/denyList.ts";
import { DEFAULT_GATE_CONFIG, type Mandate } from "../src/core/types.ts";
import {
  createXmtpIngress,
  type XmtpIngressClient,
  type XmtpMessageCtx,
} from "../src/ingress/xmtp.ts";

const NOW = "2026-05-30T12:00:00.000Z";

// A fake XMTP client: stores the handler, lets the test emit messages, captures replies.
function fakeClient() {
  let handler: ((ctx: XmtpMessageCtx) => Promise<void> | void) | null = null;
  const replies: string[] = [];
  const client: XmtpIngressClient = {
    on: (_e, h) => {
      handler = h;
    },
    start: () => {},
  };
  async function emit(content: unknown, opts: { isAllowed?: boolean } = {}) {
    await handler?.({
      content,
      senderInboxId: "inbox-123",
      isAllowed: opts.isAllowed,
      sendText: (t) => {
        replies.push(t);
      },
    });
  }
  return { client, replies, emit };
}

function setup() {
  const store = createMemoryStore("k");
  store.insertMandate({
    id: "m",
    label: "groceries",
    scope: { kind: "class", value: "groceries" },
    currency: "GBP",
    allowedRails: ["card"],
    perTxCap: 500_00,
    perPeriodCap: 1000_00,
    period: "week",
    grantedAt: "2026-05-26T00:00:00.000Z",
    expiresAt: "2026-06-26T00:00:00.000Z",
    status: "active",
  } satisfies Mandate);
  store.insertIntent({
    intent: {
      id: "seed",
      payee: "tesco",
      payeeClass: "groceries",
      amount: 80_00,
      currency: "GBP",
      rail: "card",
      rationale: "seed",
      createdAt: NOW,
    },
    status: "settled",
    mandateId: "m",
    reasons: [],
    settledAt: "2026-05-26T09:00:00.000Z",
    receiptId: "r",
  });
  const executor = createExecutor({
    store,
    rails: createRailRegistry([createFakeRail("card")]),
    audit: new AuditLog(store.operatorKey()),
    config: DEFAULT_GATE_CONFIG,
    denyRules: DEFAULT_DENY_RULES,
    clock: () => NOW,
  });
  let n = 0;
  const f = fakeClient();
  createXmtpIngress({ client: f.client, executor, clock: () => NOW, newId: () => `pi_${n++}` });
  return f;
}

const req = (payee: string, amount: number) =>
  JSON.stringify({ payee, payeeClass: "groceries", amount, currency: "GBP", rail: "card", rationale: "xmtp request" });

test("an inbound XMTP request runs through the gate (known payee → settled)", async () => {
  const f = setup();
  await f.emit(req("tesco", 80_00));
  assert.match(f.replies[0], /^settled/);
});

test("an over-cap XMTP request is blocked through the gate", async () => {
  const f = setup();
  await f.emit(req("tesco", 600_00));
  assert.match(f.replies[0], /^blocked/);
});

test("XMTP consent is honored (denied sender is ignored)", async () => {
  const f = setup();
  await f.emit(req("tesco", 80_00), { isAllowed: false });
  assert.equal(f.replies.length, 0);
});

test("a non-payment message is ignored, not executed", async () => {
  const f = setup();
  await f.emit("gm");
  assert.match(f.replies[0], /ignored/);
});
