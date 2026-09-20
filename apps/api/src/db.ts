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

  if (process.env.NODE_ENV === "test") {
    const { createTestDb } = await import("@gitlit/db/testing");
    const { db } = await createTestDb();
    database = db;
    return database;
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  database = drizzlePg(postgres(url, { max: 10 }), { schema });
  return database;
}

export function db(): Database {
  if (!database) throw new Error("Database not initialised — call initDb() first");
  return database;
}
