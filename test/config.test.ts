import test from "node:test";
import assert from "node:assert/strict";

import {
  loadConfig,
  migrateConfig,
  defaultConfig,
  CURRENT_CONFIG_VERSION,
  OpenSolvencyConfigSchema,
} from "../src/config/schema.ts";

test("defaultConfig is valid and current", () => {
  const c = defaultConfig();
  assert.equal(c.version, CURRENT_CONFIG_VERSION);
  assert.doesNotThrow(() => OpenSolvencyConfigSchema.parse(c));
});

test("a pre-versioning (v0) config migrates up and fills defaults", () => {
  // no version, only a partial gate override
  const c = loadConfig({ gate: { minRationaleChars: 20 } });
  assert.equal(c.version, CURRENT_CONFIG_VERSION);
  assert.equal(c.gate.minRationaleChars, 20); // override kept
  assert.equal(c.gate.velocityMaxCount, 5); // default filled
  assert.equal(c.ingress.port, 8787); // default group filled
});

test("partial overrides deep-merge over defaults", () => {
  const c = loadConfig({ version: 1, ingress: { host: "0.0.0.0" } });
  assert.equal(c.ingress.host, "0.0.0.0");
  assert.equal(c.ingress.port, 8787);
});

test("migrateConfig is pure (does not mutate input) and stamps the current version", () => {
  const input = { gate: { velocityMaxCount: 9 } };
  const out = migrateConfig(input) as { version: number };
  assert.equal(out.version, CURRENT_CONFIG_VERSION);
  assert.deepEqual(input, { gate: { velocityMaxCount: 9 } }); // unchanged
});

test("an invalid config is rejected by the schema", () => {
  assert.throws(() => loadConfig({ version: 1, ingress: { port: 999999, host: "x" } }));
});
