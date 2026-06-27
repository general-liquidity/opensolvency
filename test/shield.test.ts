import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { startShield } from "../src/core/shield.ts";
import { AuditLog } from "../src/core/audit.ts";

test("startShield performs initial check and watches for file changes to engage kill switch", (t, done) => {
  const tempDb = join(process.cwd(), "temp_shield_test.db");
  writeFileSync(tempDb, "initial db content");

  let killSwitchEngaged = false;
  let verifyShouldFail = false;

  const mockAudit = {
    verify: () => {
      if (verifyShouldFail) {
        return { valid: false, brokenAt: 1, reason: "tampered hash" };
      }
      return { valid: true, brokenAt: null, reason: null };
    },
  } as unknown as AuditLog;

  const mockExecutor = {
    engageKillSwitch: () => {
      killSwitchEngaged = true;
    },
    isKillSwitchEngaged: () => killSwitchEngaged,
  };

  const shield = startShield({
    dbPath: tempDb,
    poll: true, // fs.watch is flaky for this temp file; poll deterministically
    executor: mockExecutor,
    audit: mockAudit,
  });

  // Verify initial state: valid database, kill switch not engaged
  assert.equal(killSwitchEngaged, false);

  // Now, simulate database tampering and trigger a file write
  verifyShouldFail = true;
  writeFileSync(tempDb, "tampered db content");

  // Wait briefly for FS watch event to propagate
  setTimeout(() => {
    try {
      assert.equal(killSwitchEngaged, true);
      shield.close();
      unlinkSync(tempDb);
      done();
    } catch (err) {
      shield.close();
      unlinkSync(tempDb);
      done(err);
    }
  }, 100);
});
