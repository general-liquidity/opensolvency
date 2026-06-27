import { watch, watchFile, unwatchFile } from "node:fs";
import type { AuditLog } from "./audit.ts";

export interface ShieldOptions {
  dbPath: string;
  /** Force the polling watcher instead of native fs events. Needed on
   *  virtualized mounts (WSL `/mnt/…`) and in tests where `fs.watch` is flaky.
   *  Defaults to true for `/mnt/` paths, false otherwise. */
  poll?: boolean;
  executor: {
    engageKillSwitch(): void;
    isKillSwitchEngaged(): boolean;
  };
  audit: AuditLog;
}

/**
 * Monitors the database and configuration files in real-time.
 * If unauthorized modification attempts break the signed audit trail,
 * it instantly engages the executor's Kill Switch to block all further spend.
 */
export function startShield(opts: ShieldOptions) {
  let isChecking = false;

  const checkIntegrity = () => {
    if (isChecking) return;
    isChecking = true;

    try {
      const result = opts.audit.verify();
      if (!result.valid) {
        console.warn(
          `[SHIELD WARNING] Integrity verification failed: ${result.reason}. ` +
            `Engaging hard Kill Switch to protect assets.`,
        );
        if (!opts.executor.isKillSwitchEngaged()) {
          opts.executor.engageKillSwitch();
        }
      }
    } catch (err) {
      console.error("[SHIELD ERROR] Exception during integrity check. Halting spend:", err);
      if (!opts.executor.isKillSwitchEngaged()) {
        opts.executor.engageKillSwitch();
      }
    } finally {
      isChecking = false;
    }
  };

  // Perform startup verification
  checkIntegrity();

  const usePolling = opts.poll ?? opts.dbPath.startsWith("/mnt/");
  let watcher: { close(): void };

  if (usePolling) {
    // Polling watch for WSL / virtualized mounts
    watchFile(opts.dbPath, { interval: 50 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) {
        checkIntegrity();
      }
    });
    watcher = {
      close: () => {
        unwatchFile(opts.dbPath);
      },
    };
  } else {
    // Native filesystem events watcher
    const fsWatcher = watch(opts.dbPath, (eventType) => {
      if (eventType === "change") {
        checkIntegrity();
      }
    });
    watcher = {
      close: () => {
        fsWatcher.close();
      },
    };
  }

  return {
    verifyNow: checkIntegrity,
    close: () => {
      watcher.close();
    },
  };
}
