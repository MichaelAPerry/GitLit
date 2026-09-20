import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url, { max: 10 });
  return { db: drizzle(client, { schema }), client };
}

/**
 * The driver-agnostic database type.
 *
 * Pinning this to PostgresJsDatabase would mean the PGlite instance the tests
 * run against is a different type from the one production uses — so the tests
 * would not be exercising the same code paths they claim to. This is the
 * supertype both drivers satisfy.
 */
export type Database = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
