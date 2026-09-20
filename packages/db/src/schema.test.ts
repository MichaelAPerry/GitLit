import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, truncateAll, type TestDb } from "./testing.js";
import * as s from "./schema.js";

let db: TestDb;
let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let close: () => Promise<void>;

beforeAll(async () => { ({ db, client, close } = await createTestDb()); });
beforeEach(async () => { await truncateAll(client); });
afterAll(async () => { await close(); });

const user = (over: Partial<typeof s.users.$inferInsert> = {}) => ({
  id: `u_${Math.random().toString(36).slice(2)}`,
  handle: `h${Math.random().toString(36).slice(2, 8)}`,
  email: `${Math.random().toString(36).slice(2)}@example.com`,
  ...over,
});

describe("migrations", () => {
  it("apply cleanly against real Postgres", async () => {
    const rows = await db.execute(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    const names = rows.rows.map((r) => (r as { table_name: string }).table_name);
    for (const expected of [
      "users", "sessions", "magic_links", "api_tokens", "repositories",
      "repository_collaborators", "commits", "provenance_spans", "provenance_receipts",
      "authoring_sessions", "input_events", "agent_sessions", "agent_tool_calls",
      "timeline_events",
    ]) {
      expect(names, expected).toContain(expected);
    }
  });
});

describe("constraints actually hold", () => {
  it("rejects a duplicate handle", async () => {
    const a = user({ handle: "mara" });
    await db.insert(s.users).values(a);
    await expect(db.insert(s.users).values(user({ handle: "mara" }))).rejects.toThrow();
  });

  it("rejects a duplicate email", async () => {
    await db.insert(s.users).values(user({ email: "m@example.com" }));
    await expect(db.insert(s.users).values(user({ email: "m@example.com" }))).rejects.toThrow();
  });

  it("rejects a session for a user that does not exist", async () => {
    await expect(db.insert(s.sessions).values({
      id: "sess_1", userId: "u_ghost", selector: "sel", verifier: "v",
      expiresAt: new Date(Date.now() + 1000),
    })).rejects.toThrow();
  });

  it("cascades session deletion when the user goes", async () => {
    const u = user();
    await db.insert(s.users).values(u);
    await db.insert(s.sessions).values({
      id: "sess_1", userId: u.id, selector: "sel", verifier: "v",
      expiresAt: new Date(Date.now() + 1000),
    });
    await db.delete(s.users).where(eq(s.users.id, u.id));
    expect(await db.select().from(s.sessions)).toHaveLength(0);
  });

  it("ENFORCES one repository slug per owner — a nullable composite index would not", async () => {
    const u = user();
    await db.insert(s.users).values(u);
    const repo = {
      id: "repo_1", ownerUserId: u.id, slug: "saltmarsh", title: "Saltmarsh",
      form: "novel", storagePath: "/repos/x.git",
    };
    await db.insert(s.repositories).values(repo);
    await expect(db.insert(s.repositories).values({ ...repo, id: "repo_2" })).rejects.toThrow();
  });

  it("allows the same slug for different owners", async () => {
    const a = user();
    const b = user();
    await db.insert(s.users).values([a, b]);
    await db.insert(s.repositories).values({
      id: "repo_1", ownerUserId: a.id, slug: "saltmarsh", title: "A", form: "novel", storagePath: "/a",
    });
    await expect(db.insert(s.repositories).values({
      id: "repo_2", ownerUserId: b.id, slug: "saltmarsh", title: "B", form: "novel", storagePath: "/b",
    })).resolves.toBeDefined();
  });

  it("requires exactly one owner, never both", async () => {
    const u = user();
    await db.insert(s.users).values(u);
    await db.insert(s.organizations).values({ id: "org_1", slug: "press", name: "Press" });
    await expect(db.insert(s.repositories).values({
      id: "repo_1", ownerUserId: u.id, ownerOrgId: "org_1",
      slug: "b", title: "B", form: "novel", storagePath: "/x",
    })).rejects.toThrow();
  });

  it("requires an owner at all", async () => {
    await expect(db.insert(s.repositories).values({
      id: "repo_1", slug: "b", title: "B", form: "novel", storagePath: "/x",
    })).rejects.toThrow();
  });

  it("keys a commit by repo and sha together", async () => {
    const u = user();
    await db.insert(s.users).values(u);
    await db.insert(s.repositories).values({
      id: "repo_1", ownerUserId: u.id, slug: "b", title: "B", form: "novel", storagePath: "/x",
    });
    const commit = {
      repoId: "repo_1", sha: "a".repeat(40), authorName: "M", authorEmail: "m@x",
      committedAt: new Date(), message: "m", provenance: "human",
    };
    await db.insert(s.commits).values(commit);
    await expect(db.insert(s.commits).values(commit)).rejects.toThrow();
  });

  it("stores array and jsonb columns faithfully", async () => {
    const u = user();
    await db.insert(s.users).values(u);
    await db.insert(s.repositories).values({
      id: "repo_1", ownerUserId: u.id, slug: "b", title: "B", form: "novel",
      storagePath: "/x", genre: ["literary", "gothic"],
    });
    await db.insert(s.authoringSessions).values({
      id: "as_1", repoId: "repo_1", userId: u.id, startedAt: new Date(),
      client: "write_web", modeWords: { typed: 812, pasted: 140 },
      ikiHistogram: [1, 2, 3, 4],
    });
    const [session] = await db.select().from(s.authoringSessions);
    expect(session!.modeWords).toEqual({ typed: 812, pasted: 140 });
    expect(session!.ikiHistogram).toEqual([1, 2, 3, 4]);
    const [repo] = await db.select().from(s.repositories);
    expect(repo!.genre).toEqual(["literary", "gothic"]);
  });

  it("round-trips an embedding array", async () => {
    await db.insert(s.priorWorks).values({
      id: "pw_1", source: "openlibrary", externalId: "1", title: "T",
      embedding: [0.25, -0.5, 0.75],
    });
    const [row] = await db.select().from(s.priorWorks);
    expect(row!.embedding).toEqual([0.25, -0.5, 0.75]);
  });

  it("defaults repositories to private", async () => {
    const u = user();
    await db.insert(s.users).values(u);
    await db.insert(s.repositories).values({
      id: "repo_1", ownerUserId: u.id, slug: "b", title: "B", form: "novel", storagePath: "/x",
    });
    const [repo] = await db.select().from(s.repositories);
    expect(repo!.visibility).toBe("private");
    expect(repo!.haltOnDerivative).toBe(true);
    expect(repo!.galleryOptIn).toBe(false);
  });
});
