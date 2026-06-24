#!/usr/bin/env node
// REAL on-chain settlement through the gate — on a TESTNET.
//
// This is the operator-run path that takes OpenSolvency past the fail-safe stubs:
// a genuine ERC-20 stablecoin transfer (e.g. testnet USDC) executed by the SAME
// executor + gate as everything else. It lives in scripts/ (not the shipped dist):
// the published package exposes the `OnchainSigner` seam + `createOnchainRailClient`,
// and this is the runnable example that wires a live viem wallet into it.
//
// It needs a funded testnet key — which only YOU can supply, so the actual money
// movement is yours. Set the env below and run:
//
//   OPENSOLVENCY_RPC_URL=https://sepolia.base.org \
//   OPENSOLVENCY_PRIVATE_KEY=0x...        (a funded testnet key) \
//   OPENSOLVENCY_TOKEN_ADDRESS=0x...      (testnet USDC, 6 decimals) \
//   OPENSOLVENCY_PAYEE_ADDRESS=0x...      (where to send) \
//   OPENSOLVENCY_AMOUNT=10000             (base units; 10000 = 0.01 USDC) \
//   OPENSOLVENCY_CHAIN=base-sepolia       (or sepolia) \
//   npm run testnet-settle
//
// Defaults: Base Sepolia, 0.01 USDC. The gate runs for real — an over-cap or
// deny-listed intent is blocked before any transfer.

import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, sepolia } from "viem/chains";

import { AuditLog } from "../src/core/audit.ts";
import { createExecutor } from "../src/core/executor.ts";
import { createMemoryStore } from "../src/store/memoryStore.ts";
import { createRailRegistry } from "../src/rails/registry.ts";
import { createX402Rail } from "../src/rails/x402.ts";
import { createOnchainRailClient, type Address, type OnchainSigner } from "../src/rails/clients/onchainClient.ts";
import { DEFAULT_DENY_RULES } from "../src/core/denyList.ts";
import { DEFAULT_GATE_CONFIG, type Mandate, type PaymentIntent } from "../src/core/types.ts";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    console.error(`missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

const CHAINS = { "base-sepolia": baseSepolia, sepolia } as const;

async function main(): Promise<void> {
  const rpcUrl = env("OPENSOLVENCY_RPC_URL", "https://sepolia.base.org");
  const privateKey = env("OPENSOLVENCY_PRIVATE_KEY") as `0x${string}`;
  const tokenAddress = env("OPENSOLVENCY_TOKEN_ADDRESS") as Address;
  const payeeAddress = env("OPENSOLVENCY_PAYEE_ADDRESS") as Address;
  const amount = Number(env("OPENSOLVENCY_AMOUNT", "10000")); // 0.01 USDC (6 dp)
  const chainKey = env("OPENSOLVENCY_CHAIN", "base-sepolia") as keyof typeof CHAINS;
  const chain = CHAINS[chainKey];
  if (!chain) {
    console.error(`unknown chain '${chainKey}' — use one of: ${Object.keys(CHAINS).join(", ")}`);
    process.exit(1);
  }

  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

  // Adapt the viem WalletClient to the repo's injected `OnchainSigner` seam. The
  // account + chain live on the client, so writeContract can omit them; the cast
  // bridges viem's strict abi generics to the seam's `readonly unknown[]` abi.
  const signer: OnchainSigner = {
    writeContract: (args) => wallet.writeContract(args as never),
  };

  const railClient = createOnchainRailClient({
    signer,
    tokenAddress,
    resolvePayee: (payee) => (payee === "testnet-payee" ? payeeAddress : undefined),
  });

  const store = createMemoryStore();
  const audit = new AuditLog(store.operatorKey());
  const rails = createRailRegistry([createX402Rail(railClient)]);
  const now = () => new Date().toISOString();
  const executor = createExecutor({
    store, rails, audit, config: DEFAULT_GATE_CONFIG, denyRules: DEFAULT_DENY_RULES, clock: now,
  });

  // Grant a mandate that covers this transfer (USDC base units), and vet the payee
  // (seed a prior settled payment) so the deny-list's irreversible-to-UNKNOWN-payee
  // rule doesn't block a vetted address. This is the operator vetting the payee.
  const mandate: Mandate = {
    id: "m_testnet", label: "testnet", scope: { kind: "class", value: "testnet" },
    currency: "USDC", allowedRails: ["onchain"], perTxCap: 1_000_000, perPeriodCap: 5_000_000,
    period: "day", grantedAt: now(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), status: "active",
  };
  store.insertMandate(mandate);
  store.insertIntent({
    intent: { id: "seed", payee: "testnet-payee", payeeClass: "testnet", amount: 1, currency: "USDC", rail: "onchain", rationale: "operator vetted this address", createdAt: now() },
    status: "settled", mandateId: null, reasons: ["vetted"], settledAt: now(), receiptId: "seed",
  });

  const intent: PaymentIntent = {
    id: `pi_${Date.now()}`, payee: "testnet-payee", payeeClass: "testnet",
    amount, currency: "USDC", rail: "onchain", rationale: `testnet settlement of ${amount} USDC base units`,
    createdAt: now(),
  };

  console.log(`submitting ${amount} USDC base units → ${payeeAddress} on ${chainKey} …`);
  const result = await executor.execute(intent);
  console.log(`gate outcome: ${result.status} — ${result.decision.reasons.join("; ")}`);
  if (result.status === "settled" && result.receipt) {
    console.log(`SETTLED on-chain. tx: ${result.receipt.providerRef}`);
    console.log(`read-back verified: ${result.verified}`);
  } else {
    console.log("no transfer was made (the gate did not auto-execute).");
  }
  console.log(`audit chain valid: ${audit.verify().valid}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
