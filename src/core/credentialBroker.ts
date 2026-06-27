import type { PaymentIntent, Receipt } from "./types.ts";
import type { PaymentProvider } from "../rails/provider.ts";

/**
 * Symbol-keyed so a brokered secret is never enumerated, JSON-serialized, or
 * logged with the intent. Only a rail adapter that imports this symbol can read
 * the injected credential off the settlement intent.
 */
export const BROKERED_SECRET = Symbol("agentworth.brokeredSecret");

/**
 * Gated Rail Credential Brokerage.
 *
 * Holds sensitive rail credentials (Stripe API keys, wallet private keys, …) in a
 * PER-INSTANCE in-memory vault — there is no global/static state, so one
 * operator/tenant's broker can never read another's keys. A credential is injected
 * into an outbound settlement ONLY after the gate has authorized the payment
 * (the broker wraps the provider, and the executor only reaches `settle` on an
 * auto-execute decision).
 */
export class CredentialBroker {
  private readonly credentials = new Map<string, string>();

  /** Store a credential under a key name (this broker instance only). */
  storeCredential(key: string, secret: string): void {
    this.credentials.set(key, secret);
  }

  /**
   * Retrieve the raw credential. Throws if unregistered — inside `executor.settle`
   * that throw is caught and recorded as `payment.failed`, so a missing credential
   * fails safe (no fabricated settlement).
   */
  retrieveCredential(key: string): string {
    const val = this.credentials.get(key);
    if (!val) {
      throw new Error(`CredentialBroker: credential "${key}" is not registered or configured.`);
    }
    return val;
  }

  /** Whether a credential key is configured on this broker. */
  hasCredential(key: string): boolean {
    return this.credentials.has(key);
  }

  /** Clear all credentials from this broker's vault. */
  clear(): void {
    this.credentials.clear();
  }

  /**
   * Wrap a PaymentProvider so the retrieved credential is injected on-the-fly at
   * settlement (replacing any placeholder token the agent passed). The secret is
   * attached under the `BROKERED_SECRET` symbol, so it is excluded from
   * `JSON.stringify`/`Object.keys` and cannot leak through audit/logging of the intent.
   */
  brokerProvider(provider: PaymentProvider, credentialKey: string): PaymentProvider {
    const broker = this;
    return {
      capabilities: provider.capabilities,
      settle: async (intent: PaymentIntent, now: string): Promise<Receipt> => {
        const secret = broker.retrieveCredential(credentialKey);
        const brokeredIntent: PaymentIntent & { [BROKERED_SECRET]?: string } = {
          ...intent,
          [BROKERED_SECRET]: secret,
        };
        return await provider.settle(brokeredIntent, now);
      },
      verifyReceipt: (receipt: Receipt): boolean => provider.verifyReceipt(receipt),
      refund: provider.refund
        ? (receipt: Receipt, amountMinor: number, now: string) =>
            provider.refund!(receipt, amountMinor, now)
        : undefined,
    };
  }
}
