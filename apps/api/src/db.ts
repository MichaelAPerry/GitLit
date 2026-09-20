import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema, type Database } from "@gitlit/db";

let database: Database | null = null;

/**
 * The application database.
 *
 * Tests run against PGlite — real Postgres in-process — so the SQL that ships
 * is the SQL the tests exercised. A repository layer verified against a mock
 * is a repository layer nobody has tested.
 */
export async function initDb(): Promise<Database> {
  if (database) return database;

  // Tests: ephemeral, in-process, migrated fresh.
  if (process.env.NODE_ENV === "test") {
    const { createTestDb } = await import("@gitlit/db/testing");
    ({ db: database } = await createTestDb());
    return database;
  }

  const url = process.env.DATABASE_URL;

  if (!url) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("DATABASE_URL must be set in production.");
    }
    /**
     * Development without a Postgres to hand. File-backed PGlite is real
     * Postgres and the data persists, so `pnpm dev` works with no Docker —
     * but it is single-process, so say so rather than let someone discover it
     * under load.
     */
    const dir = process.env.PGLITE_DIR ?? "./.gitlit-dev-db";
    // eslint-disable-next-line no-console
    console.warn(
      `DATABASE_URL is unset — using a local PGlite database at ${dir}. ` +
      `Real Postgres, but single-process. Set DATABASE_URL for anything shared.`,
    );
    const { createDevDb } = await import("@gitlit/db/testing");
    ({ db: database } = await createDevDb(dir));
    return database;
  }

  database = drizzlePg(postgres(url, { max: 10 }), { schema });
  return database;
}

export function db(): Database {
  if (!database) throw new Error("Database not initialised — call initDb() first");
  return database;
}
