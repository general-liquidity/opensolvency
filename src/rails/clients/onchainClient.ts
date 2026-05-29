// A REAL settlement client for the on-chain (x402) rail: an ERC-20 transfer of a
// stablecoin (e.g. USDC on Base). It depends on an injected `OnchainSigner` (a
// subset of a viem WalletClient) rather than importing viem or embedding a chain
// transport — so the settlement logic is correct and unit-testable here, while
// the live key + RPC are supplied by the operator (the only thing that can move
// real funds). Plugs into `createX402Rail(client)`; with no client the rail fails
// safe, exactly as before.
//
// amount is integer minor-units == the token's smallest unit (USDC has 6 decimals,
// so 1_000_000 minor-units = 1 USDC), consistent with the rest of the system.

import type { PaymentIntent } from "../../core/types.ts";
import type { RailClient, RailSettlement } from "../networkRail.ts";

export type Address = `0x${string}`;
export type TxHash = `0x${string}`;

/** The subset of a viem WalletClient we use. A real viem client satisfies it
 * (possibly via a thin adapter); a mock satisfies it in tests. */
export interface OnchainSigner {
  writeContract(args: {
    address: Address;
    abi: readonly unknown[];
    functionName: "transfer";
    args: readonly [Address, bigint];
  }): Promise<TxHash>;
}

export interface OnchainRailConfig {
  signer: OnchainSigner;
  /** The stablecoin token contract (e.g. Base USDC). */
  tokenAddress: Address;
  /** Map an operator-facing payee id to its on-chain address. */
  resolvePayee: (payee: string) => Address | undefined;
}

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export function createOnchainRailClient(config: OnchainRailConfig): RailClient {
  return {
    async settle(intent: PaymentIntent): Promise<RailSettlement> {
      const to = config.resolvePayee(intent.payee);
      if (!to) {
        throw new Error(`onchain rail: no address registered for payee ${intent.payee}`);
      }
      const txHash = await config.signer.writeContract({
        address: config.tokenAddress,
        abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [to, BigInt(intent.amount)],
      });
      return { providerRef: txHash, finality: "final" }; // on-chain ⇒ irreversible
    },
    verifyReceipt: (receipt) =>
      receipt.providerRef.startsWith("0x") && receipt.providerRef.length >= 4,
  };
}
