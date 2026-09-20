import { MIGRATIONS_FOLDER, runMigrations } from "./migrate.js";

/**
 * The release step. Fails loudly and non-zero, so a bad migration stops the
 * deploy rather than letting a new image start against an old schema.
 */
try {
  await runMigrations();
  // eslint-disable-next-line no-console
  console.log(`migrations applied from ${MIGRATIONS_FOLDER}`);
} catch (err) {
  // eslint-disable-next-line no-console
  console.error("migration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}
