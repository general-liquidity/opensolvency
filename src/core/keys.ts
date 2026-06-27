// Operator audit-signing key custody. The audit chain is signed with the
// operator's key; WHERE that key lives is a custody decision. By default it's the
// store-persisted random key, but an operator can inject one from the environment
// or a KMS via a KeyProvider — the signing key never has to sit in the database.
//
// NOTE: rotating the key mid-chain would break verification of earlier entries
// (they were signed with the old key). True rotation needs per-entry key
// versioning (an AuditEntry.keyId + a keyring) — deferred; documented here so it
// isn't reinvented as random-and-unmanaged.

export interface KeyProvider {
  operatorKey(): string;
}

export function staticKeyProvider(key: string): KeyProvider {
  if (!key) throw new Error("staticKeyProvider requires a non-empty key");
  return { operatorKey: () => key };
}

export function envKeyProvider(envVar = "AGENTWORTH_AUDIT_KEY"): KeyProvider {
  const key = process.env[envVar];
  if (!key) throw new Error(`audit key not found in ${envVar}`);
  return { operatorKey: () => key };
}
