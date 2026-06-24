// Versioned operator config — a validated, migratable config file for tuning the
// gate + runtime, mirroring the money-domain mandate-lifecycle discipline (every
// persisted shape is versioned and forward-migrated, never silently reinterpreted).
//
// The file carries an explicit `version`; `loadConfig` migrates an older shape up
// to the current version, then validates with zod. Unknown future fields and a
// missing version are tolerated by migration, not by loosening the schema.

import { z } from "zod";
import { DEFAULT_GATE_CONFIG } from "../core/types.ts";

export const CURRENT_CONFIG_VERSION = 1;

const GateConfigSchema = z.object({
  minRationaleChars: z.number().int().nonnegative(),
  velocityWindowMinutes: z.number().int().positive(),
  velocityMaxCount: z.number().int().positive(),
  anomalyMultiple: z.number().positive(),
});

export const OpenSolvencyConfigSchema = z.object({
  version: z.literal(CURRENT_CONFIG_VERSION),
  gate: GateConfigSchema,
  /** consecutive blocks/failures before the circuit breaker trips */
  circuitBreakerThreshold: z.number().int().positive(),
  /** pending intents at/above this (minor-units) need challenge-response on approve */
  challengeThresholdMinor: z.number().int().positive(),
  ingress: z.object({
    port: z.number().int().min(1).max(65535),
    host: z.string(),
  }),
});

export type OpenSolvencyConfig = z.infer<typeof OpenSolvencyConfigSchema>;

export function defaultConfig(): OpenSolvencyConfig {
  return {
    version: CURRENT_CONFIG_VERSION,
    gate: { ...DEFAULT_GATE_CONFIG },
    circuitBreakerThreshold: 4,
    challengeThresholdMinor: 100_000,
    ingress: { port: 8787, host: "127.0.0.1" },
  };
}

/**
 * Forward-migrate a raw config object to the CURRENT version. A config with no
 * `version` is treated as the pre-versioning shape (v0) and filled with defaults
 * for any missing field; each future version adds a case here. Pure.
 */
export function migrateConfig(raw: unknown): unknown {
  const base = defaultConfig() as Record<string, unknown>;
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const version = typeof obj.version === "number" ? obj.version : 0;

  // v0 (or absent) → v1: merge over defaults, deep-merging the nested groups.
  const migrated: Record<string, unknown> = {
    ...base,
    ...obj,
    version: CURRENT_CONFIG_VERSION,
    gate: { ...(base.gate as object), ...((obj.gate as object) ?? {}) },
    ingress: { ...(base.ingress as object), ...((obj.ingress as object) ?? {}) },
  };
  void version; // each future bump adds: if (version < N) migrated = upgradeToN(migrated)
  return migrated;
}

/** Migrate then validate. Throws (zod) on a config that can't be made valid. */
export function loadConfig(raw: unknown): OpenSolvencyConfig {
  return OpenSolvencyConfigSchema.parse(migrateConfig(raw));
}
