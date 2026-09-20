import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";

/**
 * A real Postgres for tests, running in-process via PGlite.
 *
 * This is not a mock or an in-memory stand-in with different semantics: it is
 * Postgres compiled to WASM, running the same migrations production runs. A
 * repository layer tested against a fake is a repository layer that has never
 * been tested, and the SQL layer was the part most likely to be wrong.
 */
export async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const here = path.dirname(fileURLToPath(import.meta.url));
  await migrate(db, { migrationsFolder: path.resolve(here, "../migrations") });
  return { db, client, close: () => client.close() };
}

/**
 * A persistent local database for development without Docker. Same Postgres,
 * same migrations, backed by a directory instead of memory.
 */
export async function createDevDb(dir: string) {
  const client = new PGlite(dir);
  const db = drizzle(client, { schema });
  const here = path.dirname(fileURLToPath(import.meta.url));
  await migrate(db, { migrationsFolder: path.resolve(here, "../migrations") });
  return { db, client, close: () => client.close() };
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];

/**
 * Empty every table without re-running migrations. Booting PGlite costs a
 * couple of seconds, so suites create one database per file and reset between
 * tests rather than per test.
 */
export async function truncateAll(client: PGlite): Promise<void> {
  const { rows } = await client.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' and tablename <> '__drizzle_migrations'",
  );
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(", ");
  await client.exec(`truncate table ${list} restart identity cascade;`);
}
