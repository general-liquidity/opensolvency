import { test } from "node:test";
import assert from "node:assert/strict";

import { AuditLog } from "../src/core/audit.ts";
import { createExecutor } from "../src/core/executor.ts";
import { createMemoryStore } from "../src/store/memoryStore.ts";
import { createRailRegistry } from "../src/rails/registry.ts";
import { createX402Rail } from "../src/rails/x402.ts";
import {
  createOnchainRailClient,
  type Address,
  type OnchainSigner,
  type TxHash,
} from "../src/rails/clients/onchainClient.ts";
import { DEFAULT_DENY_RULES } from "../src/core/denyList.ts";
import { DEFAULT_GATE_CONFIG, type Mandate, type PaymentIntent } from "../src/core/types.ts";

const NOW = "2026-05-30T12:00:00.000Z";
const TOKEN: Address = "0xUSDCtoken000000000000000000000000000000";
const ALICE: Address = "0xalice00000000000000000000000000000000000";

function mockSigner() {
  const calls: Array<{ functionName: string; args: readonly [Address, bigint] }> = [];
  const signer: OnchainSigner = {
    async writeContract(args) {
      calls.push({ functionName: args.functionName, args: args.args });
      return "0xdeadbeefcafe" as TxHash;
    },
  };
  return { signer, calls };
}

const intent = (over: Partial<PaymentIntent> = {}): PaymentIntent => ({
  id: "pi_1",
  payee: "alice",
  payeeClass: "saas",
  amount: 1_000_000, // 1 USDC (6 decimals)
  currency: "USDC",
  rail: "onchain",
  rationale: "monthly subscription",
  createdAt: NOW,
  ...over,
});

test("the onchain client issues an ERC-20 transfer and shapes a receipt", async () => {
  const { signer, calls } = mockSigner();
  const client = createOnchainRailClient({
    signer,
    tokenAddress: TOKEN,
    resolvePayee: (p) => (p === "alice" ? ALICE : undefined),
  });
  const s = await client.settle(intent());
  assert.equal(s.providerRef, "0xdeadbeefcafe");
  assert.equal(s.finality, "final");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].functionName, "transfer");
  assert.deepEqual(calls[0].args, [ALICE, 1_000_000n]); // minor-units → token base units
});

test("the onchain client refuses an unresolvable payee (fail safe)", async () => {
  const { signer } = mockSigner();
  const client = createOnchainRailClient({ signer, tokenAddress: TOKEN, resolvePayee: () => undefined });
  await assert.rejects(() => Promise.resolve(client.settle(intent({ payee: "stranger" }))));
});

test("end-to-end: a real client settles through the executor and is read back", async () => {
  const { signer } = mockSigner();
  const store = createMemoryStore("k");
  store.insertMandate({
    id: "m_saas",
    label: "saas",
    scope: { kind: "class", value: "saas" },
    currency: "USDC",
    allowedRails: ["onchain"],
    perTxCap: 5_000_000,
    perPeriodCap: 20_000_000,
    period: "month",
    grantedAt: "2026-05-01T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    status: "active",
  } satisfies Mandate);
  // Seed a settled payment so alice is a known payee (else novel → confirm).
  store.insertIntent({
    intent: intent({ id: "seed" }),
    status: "settled",
    mandateId: "m_saas",
    reasons: [],
    settledAt: "2026-05-02T00:00:00.000Z",
    receiptId: "r",
  });
  const rails = createRailRegistry([
    createX402Rail(
      createOnchainRailClient({
        signer,
        tokenAddress: TOKEN,
        resolvePayee: (p) => (p === "alice" ? ALICE : undefined),
      }),
    ),
  ]);
  const executor = createExecutor({
    store,
    rails,
    audit: new AuditLog(store.operatorKey()),
    config: DEFAULT_GATE_CONFIG,
    denyRules: DEFAULT_DENY_RULES,
    clock: () => NOW,
  });
  const r = await executor.execute(intent({ id: "pi_live" }));
  assert.equal(r.status, "settled");
  assert.equal(r.receipt?.providerRef, "0xdeadbeefcafe");
  assert.equal(r.verified, true);
});
