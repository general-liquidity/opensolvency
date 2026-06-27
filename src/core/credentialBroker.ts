import type { PaymentIntent, Receipt } from "./types.ts";
import type { PaymentProvider } from "../rails/provider.ts";

/**
 * Gated Rail Credential Brokerage.
 * Stores sensitive payment rail credentials (e.g. Stripe API Keys, wallet private keys)
 * in an in-memory vault. It exposes a wrapper to inject these credentials into
 * outbound transactions ONLY after the mandate checks have successfully passed.
 */
export class CredentialBroker {
  private static credentials = new Map<string, string>();

  /**
   * Securely store a credential under a specific key name.
   */
  static storeCredential(key: string, secret: string): void {
    this.credentials.set(key, secret);
  }

  /**
   * Retrieve the raw credential bytes. Must only be invoked inside the executor's
   * settlement phase.
   */
  static retrieveCredential(key: string): string {
    const val = this.credentials.get(key);
    if (!val) {
      throw new Error(`CredentialBroker: credential "${key}" is not registered or configured.`);
    }
    return val;
  }

  /**
   * Check if a credential key is configured.
   */
  static hasCredential(key: string): boolean {
    return this.credentials.has(key);
  }

  /**
   * Clear all credentials from the memory vault.
   */
  static clear(): void {
    this.credentials.clear();
  }

  /**
   * Wraps a PaymentProvider to inject the retrieved credential on-the-fly during settlement,
   * replacing dummy placeholder tokens passed by the agent.
   */
  static brokerProvider(
    provider: PaymentProvider,
    credentialKey: string,
  ): PaymentProvider {
    return {
      capabilities: provider.capabilities,
      settle: async (intent: PaymentIntent, now: string): Promise<Receipt> => {
        const secret = CredentialBroker.retrieveCredential(credentialKey);

        // Simulate credential substitution: attach the secret to the executing payload.
        // In production, this maps to auth headers or private key signing in the rail adapter.
        const brokeredIntent: PaymentIntent & { _brokeredSecret?: string } = {
          ...intent,
          _brokeredSecret: secret,
        };

        return await provider.settle(brokeredIntent, now);
      },
      verifyReceipt: (receipt: Receipt): boolean => {
        return provider.verifyReceipt(receipt);
      },
      refund: (receipt: Receipt, amountMinor: number, now: string) => {
        if (!provider.refund) {
          throw new Error("Underlying provider does not support refunds.");
        }
        return provider.refund(receipt, amountMinor, now);
      },
    };
  }
}
