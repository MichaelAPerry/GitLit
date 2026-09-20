#!/usr/bin/env node
/**
 * Scheduled backup entry point.
 *
 *   node dist/backup-cli.js                 # back up everything
 *   node dist/backup-cli.js --restore <bundle> <gitdir>
 *
 * Intended for cron or a scheduled machine. Exits non-zero when any
 * repository failed, so a scheduler surfaces it rather than a silent partial
 * backup accumulating unnoticed.
 */
import path from "node:path";
import { DirectoryBackupStore, restoreRepository, runBackup } from "./backup.js";

const REPO_ROOT = process.env.REPO_ROOT ?? "./repos";
const BACKUP_DIR = process.env.BACKUP_DIR ?? "./backups";
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS ?? 30);

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "--restore") {
    const [bundlePath, gitdir] = rest;
    if (!bundlePath || !gitdir) {
      console.error("usage: backup-cli --restore <bundle> <gitdir>");
      return 2;
    }
    await restoreRepository(path.resolve(bundlePath), path.resolve(gitdir));
    console.log(`restored ${bundlePath} -> ${gitdir}`);
    return 0;
  }

  const store = new DirectoryBackupStore(path.resolve(BACKUP_DIR));
  const report = await runBackup(path.resolve(REPO_ROOT), store, { keepDays: KEEP_DAYS });

  const bytes = report.bundled.reduce((n, b) => n + b.bytes, 0);
  console.log(
    `backed up ${report.bundled.length} repositories ` +
    `(${(bytes / 1e6).toFixed(1)}MB) to ${store.location}`,
  );
  if (report.skipped.length) console.log(`skipped ${report.skipped.length} empty`);
  if (report.pruned.length) console.log(`pruned ${report.pruned.length} stale`);

  for (const failure of report.failed) {
    console.error(`FAILED ${failure.repoId}: ${failure.error}`);
  }
  if (report.failed.length > 0) {
    console.error(
      `\n${report.failed.length} repositories were not backed up. ` +
      `Stale bundles were NOT pruned, so the previous copies are still there.`,
    );
    return 1;
  }

  console.log("\nA backup nobody has restored is a hypothesis. Rehearse it:");
  console.log(`  node dist/backup-cli.js --restore ${store.location}/<id>.bundle /tmp/check.git`);
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(1);
});
