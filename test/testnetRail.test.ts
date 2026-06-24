import test from "node:test";
import assert from "node:assert/strict";

import { AuditLog } from "../src/core/audit.ts";
import { createExecutor } from "../src/core/executor.ts";
import { createMemoryStore } from "../src/store/memoryStore.ts";
import { createRailRegistry } from "../src/rails/registry.ts";
import { createX402Rail } from "../src/rails/x402.ts";
import { createOnchainRailClient, type Address, type OnchainSigner, type TxHash } from "../src/rails/clients/onchainClient.ts";
import { DEFAULT_DENY_RULES } from "../src/core/denyList.ts";
import { DEFAULT_GATE_CONFIG, type Mandate, type PaymentIntent } from "../src/core/types.ts";

// Mirror the testnet-settle script's wiring with a MOCK signer (no viem, no chain):
// proves the demo's mandate + payee-vetting + deny-list config actually lets a
// vetted on-chain transfer AUTO-EXECUTE through the gate, and that the tx hash
// flows back as the receipt's providerRef.

const NOW = "2026-06-24T12:00:00.000Z";
const FAKE_TX = "0xdeadbeefcafe1234" as TxHash;
const PAYEE_ADDR = "0x00000000000000000000000000000000000000a1" as Address;

function wire(opts: { vetted: boolean; amount: number }) {
  const calls: Array<{ to: Address; amount: bigint }> = [];
  const signer: OnchainSigner = {
    async writeContract(args) {
      calls.push({ to: args.args[0], amount: args.args[1] });
      return FAKE_TX;
    },
  };
  const railClient = createOnchainRailClient({
    signer,
    tokenAddress: "0x0000000000000000000000000000000000000abc" as Address,
    resolvePayee: (p) => (p === "testnet-payee" ? PAYEE_ADDR : undefined),
  });
  const store = createMemoryStore("k");
  const audit = new AuditLog(store.operatorKey());
  const executor = createExecutor({
    store,
    rails: createRailRegistry([createX402Rail(railClient)]),
    audit,
    config: DEFAULT_GATE_CONFIG,
    denyRules: DEFAULT_DENY_RULES,
    clock: () => NOW,
  });
  const mandate: Mandate = {
    id: "m_testnet", label: "testnet", scope: { kind: "class", value: "testnet" },
    currency: "USDC", allowedRails: ["onchain"], perTxCap: 1_000_000, perPeriodCap: 5_000_000,
    period: "day", grantedAt: NOW, expiresAt: "2026-07-24T00:00:00.000Z", status: "active",
  };
  store.insertMandate(mandate);
  if (opts.vetted) {
    store.insertIntent({
      intent: { id: "seed", payee: "testnet-payee", payeeClass: "testnet", amount: 1, currency: "USDC", rail: "onchain", rationale: "operator vetted this address", createdAt: NOW },
      status: "settled", mandateId: null, reasons: ["vetted"], settledAt: NOW, receiptId: "seed",
    });
  }
  const intent: PaymentIntent = {
    id: "pi_1", payee: "testnet-payee", payeeClass: "testnet", amount: opts.amount,
    currency: "USDC", rail: "onchain", rationale: "testnet settlement through the gate", createdAt: NOW,
  };
  return { executor, intent, calls, audit };
}

test("a vetted on-chain transfer auto-executes and returns the tx hash as the receipt", async () => {
  const { executor, intent, calls, audit } = wire({ vetted: true, amount: 10_000 }); // 0.01 USDC
  const r = await executor.execute(intent);
  assert.equal(r.status, "settled");
  assert.equal(r.receipt?.providerRef, FAKE_TX);
  assert.equal(r.verified, true);
  // the ERC-20 transfer was issued with the resolved address + amount as base units
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, PAYEE_ADDR);
  assert.equal(calls[0].amount, 10_000n);
  assert.equal(audit.verify().valid, true);
});

test("an UNVETTED payee is blocked by the deny-list — no transfer is issued", async () => {
  const { executor, intent, calls } = wire({ vetted: false, amount: 10_000 });
  const r = await executor.execute(intent);
  // irreversible (onchain) send to an unknown payee above the floor → blocked
  assert.equal(r.status, "blocked");
  assert.equal(calls.length, 0); // the signer was never called — money never moved
});
