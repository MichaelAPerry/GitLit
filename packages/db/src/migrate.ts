import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Apply migrations from a release step.
 *
 * Not `drizzle-kit migrate`: drizzle-kit is a devDependency, and a production
 * image that has to carry the dev toolchain to migrate is an image that ships
 * a compiler to run a web server. This uses the migrator built into
 * drizzle-orm, which is already a runtime dependency.
 */
export const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function runMigrations(url = process.env.DATABASE_URL): Promise<void> {
  if (!url) throw new Error("DATABASE_URL is not set — nothing to migrate.");

  // One connection, and no prepared statements: a release step runs once and
  // exits, and a pooler in transaction mode rejects prepared statements.
  const client = postgres(url, { max: 1, prepare: false });
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await client.end();
  }
}
