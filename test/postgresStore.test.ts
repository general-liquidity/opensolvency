import test from "node:test";
import assert from "node:assert/strict";

import { createPostgresStore, type PgClient } from "../src/store/postgresStore.ts";
import { AuditLog } from "../src/core/audit.ts";
import { createExecutor } from "../src/core/executor.ts";
import { createRailRegistry } from "../src/rails/registry.ts";
import { createFakeRail } from "../src/rails/fakeRail.ts";
import { DEFAULT_DENY_RULES } from "../src/core/denyList.ts";
import { DEFAULT_GATE_CONFIG, type Mandate, type PaymentIntent } from "../src/core/types.ts";

const NOW = "2026-06-24T12:00:00.000Z";

// A fake Postgres: a tiny SQL-shaped key/value engine over Maps. It understands
// only the handful of statements the adapter issues, enough to prove the
// load/persist/flush contract without a live database. An optional `failAfter`
// makes writes start throwing, to exercise the flush error surface.
function fakePg(opts: { failAfter?: number } = {}): PgClient & {
  tables: Record<string, Map<string | number, unknown>>;
  writes: number;
  failAfter?: number;
} {
  const tables: Record<string, Map<string | number, unknown>> = {
    os_meta: new Map(),
    os_mandates: new Map(),
    os_intents: new Map(),
    os_receipts: new Map(),
    os_audit: new Map(),
  };
  const api = {
    tables,
    writes: 0,
    failAfter: opts.failAfter,
    async query(text: string, params: unknown[] = []) {
      const t = text.trim();
      if (t.startsWith("CREATE TABLE")) return { rows: [] };

      // INSERT ... os_meta (key,value). The operator-key insert puts the literal
      // key in the SQL text with a single param for the value; the generic setMeta
      // passes both key and value as params.
      if (/INSERT INTO os_meta/.test(t)) {
        api.writes++;
        if (api.failAfter !== undefined && api.writes > api.failAfter) throw new Error("pg down");
        if (t.includes("'operator_key'")) {
          tables.os_meta.set("operator_key", { key: "operator_key", value: params[0] });
        } else {
          tables.os_meta.set(String(params[0]), { key: params[0], value: params[1] });
        }
        return { rows: [] };
      }
      if (/INSERT INTO os_(mandates|intents|receipts)/.test(t)) {
        api.writes++;
        if (api.failAfter !== undefined && api.writes > api.failAfter) throw new Error("pg down");
        const table = /os_(mandates|intents|receipts)/.exec(t)![0];
        tables[table].set(String(params[0]), { id: params[0], data: params[1] });
        return { rows: [] };
      }
      if (/INSERT INTO os_audit/.test(t)) {
        api.writes++;
        if (api.failAfter !== undefined && api.writes > api.failAfter) throw new Error("pg down");
        const seq = Number(params[0]);
        const existing = tables.os_audit.get(seq) as { data: unknown } | undefined;
        if (existing && existing.data !== params[1]) return { rows: [] };
        tables.os_audit.set(seq, { seq: params[0], data: params[1] });
        return { rows: [{ seq }] };
      }

      // SELECTs used by init()
      if (/SELECT value FROM os_meta WHERE key = 'operator_key'/.test(t)) {
        const row = tables.os_meta.get("operator_key") as { value: string } | undefined;
        return { rows: row ? [row] : [] };
      }
      if (/SELECT key, value FROM os_meta/.test(t)) {
        return { rows: [...tables.os_meta.values()] as Array<Record<string, unknown>> };
      }
      if (/SELECT data FROM os_mandates/.test(t)) return { rows: [...tables.os_mandates.values()] as any };
      if (/SELECT data FROM os_intents/.test(t)) return { rows: [...tables.os_intents.values()] as any };
      if (/SELECT data FROM os_receipts/.test(t)) return { rows: [...tables.os_receipts.values()] as any };
      if (/SELECT data FROM os_audit/.test(t)) {
        return { rows: [...tables.os_audit.values()].sort((a: any, b: any) => a.seq - b.seq) as any };
      }
      return { rows: [] };
    },
  };
  return api;
}

const mandate: Mandate = {
  id: "m1", label: "groceries", scope: { kind: "class", value: "groceries" }, currency: "GBP",
  allowedRails: ["card"], perTxCap: 500_00, perPeriodCap: 1000_00, period: "week",
  grantedAt: "2026-06-20T00:00:00.000Z", expiresAt: "2026-07-20T00:00:00.000Z", status: "active",
};

test("ready resolves, schema is created, and an operator key is minted + persisted", async () => {
  const pg = fakePg();
  const { store, ready } = createPostgresStore(pg);
  await ready;
  assert.ok(store.operatorKey().length > 0);
  assert.ok(pg.tables.os_meta.has("operator_key"));
});

test("using the store before ready throws (documented contract)", () => {
  const { store } = createPostgresStore(fakePg());
  assert.throws(() => store.listMandates(), /before `ready`/);
});

test("writes hit the mirror immediately and persist to Postgres after flush", async () => {
  const pg = fakePg();
  const { store, ready, flush } = createPostgresStore(pg);
  await ready;
  store.insertMandate(mandate);
  // mirror is synchronous — readable at once
  assert.equal(store.getMandate("m1")?.label, "groceries");
  await flush();
  // and durable in Postgres
  assert.ok(pg.tables.os_mandates.has("m1"));
});

test("state reloads from Postgres into a fresh mirror (durability across restarts)", async () => {
  const pg = fakePg();
  const a = createPostgresStore(pg);
  await a.ready;
  a.store.insertMandate(mandate);
  a.store.setMeta("kill_switch", "1");
  await a.flush();
  const keyBefore = a.store.operatorKey();

  // Re-open against the SAME database.
  const b = createPostgresStore(pg);
  await b.ready;
  assert.equal(b.store.operatorKey(), keyBefore, "operator key is stable across restarts");
  assert.equal(b.store.getMandate("m1")?.label, "groceries");
  assert.equal(b.store.getMeta("kill_switch"), "1");
});

test("a partial updateMandate re-persists the whole current row", async () => {
  const pg = fakePg();
  const { store, ready, flush } = createPostgresStore(pg);
  await ready;
  store.insertMandate(mandate);
  store.revokeMandate("m1");
  await flush();
  const b = createPostgresStore(pg);
  await b.ready;
  assert.equal(b.store.getMandate("m1")?.status, "revoked");
});

test("flush retains a failed write and retries it after Postgres recovers", async () => {
  // Fail every write after the init writes (operator_key insert is write #1).
  const pg = fakePg({ failAfter: 1 });
  const { store, ready, flush } = createPostgresStore(pg);
  await ready;
  store.insertMandate(mandate);
  await assert.rejects(() => flush(), /pg down/);
  assert.equal(pg.tables.os_mandates.has("m1"), false);
  pg.failAfter = undefined;
  await assert.doesNotReject(() => flush());
  assert.equal(pg.tables.os_mandates.has("m1"), true);
});

test("a conflicting durable audit sequence fails instead of hiding a fork", async () => {
  const pg = fakePg();
  const { store, ready, flush } = createPostgresStore(pg);
  await ready;
  const first = new AuditLog(store.operatorKey());
  store.appendAudit(first.append("gate.decision", { outcome: "block" }, NOW));
  await flush();

  const fork = new AuditLog(store.operatorKey());
  store.appendAudit(fork.append("gate.decision", { outcome: "auto_execute" }, NOW));
  await assert.rejects(() => flush(), /audit fork at seq 0/);
});

test("the executor's commit barrier flushes a settled payment to Postgres", async () => {
  const pg = fakePg();
  const { store, ready, flush } = createPostgresStore(pg);
  await ready;
  store.insertMandate(mandate);
  await flush();

  const executor = createExecutor({
    store,
    rails: createRailRegistry([createFakeRail("card")]),
    audit: new AuditLog(store.operatorKey(), store.loadAudit()),
    config: DEFAULT_GATE_CONFIG,
    denyRules: DEFAULT_DENY_RULES,
    clock: () => NOW,
    commit: flush, // the durability barrier
  });
  // a brand-new payee routes to pending, but that still writes the intent + audit
  const intent: PaymentIntent = {
    id: "pi1", payee: "tesco", payeeClass: "groceries", amount: 80_00, currency: "GBP",
    rail: "card", rationale: "the weekly grocery shop", createdAt: NOW,
  };
  const r = await executor.execute(intent);
  // once execute() resolves, the commit barrier has already run → durable in pg
  assert.ok(pg.tables.os_intents.has("pi1"), "intent persisted by the time execute resolved");
  assert.ok(pg.tables.os_audit.size > 0, "audit entries persisted");
  assert.equal(store.getIntent("pi1")?.status, r.status);
});
