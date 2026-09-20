import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { MIGRATIONS_FOLDER, runMigrations } from "./migrate.js";

describe("the release migration step", () => {
  it("resolves a migrations folder that exists", () => {
    // Under vitest this resolves from src/; in the image it resolves from
    // dist/. Both are one level below the package root, which is the point:
    // a release step that cannot find its own migrations fails the deploy.
    expect(existsSync(MIGRATIONS_FOLDER)).toBe(true);
    expect(readdirSync(MIGRATIONS_FOLDER).some((f) => f.endsWith(".sql"))).toBe(true);
    expect(existsSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"))).toBe(true);
  });

  it("refuses to run without a database url rather than guessing one", async () => {
    await expect(runMigrations("")).rejects.toThrow(/DATABASE_URL is not set/);
  });

  it("is a no-op on a database that is already migrated", async () => {
    const client = new PGlite();
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    const before = await client.query<{ n: number }>(
      "select count(*)::int as n from drizzle.__drizzle_migrations",
    );
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const after = await client.query<{ n: number }>(
      "select count(*)::int as n from drizzle.__drizzle_migrations",
    );

    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    await client.close();
  });
});
