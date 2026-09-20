import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./server.js";
import { SessionStore } from "./session.js";
import { Ledger } from "./ledger.js";
import { createGitlitClient, identify, type TokenIdentity } from "./gitlit-client.js";

/**
 * Streamable HTTP transport — the DEFAULT on-ramp (§8.5).
 *
 * Most GitLit authors are novelists, not developers. "Install a CLI" is a
 * large ask; "add GitLit in Claude's connector settings, then ask in plain
 * English" is not. This transport is what most users will ever touch.
 *
 * AUTHENTICATION. Every request carries a GitLit API token, and every
 * downstream call is made WITH THAT TOKEN. The server holds no credential of
 * its own: a shared server-side token would authenticate one author at the
 * door and then act for them with the operator's permissions, which is a
 * confused deputy rather than an authorization system.
 *
 * Tokens are resolved against the API and cached briefly — an MCP session is
 * many requests, and revocation still takes effect within the TTL.
 */
const app = express();
app.use(express.json({ limit: "4mb" }));

// Shared across connections so a dropped socket resumes the same agent
// session rather than silently starting a fresh, empty ledger (§2.5).
const sessions = new SessionStore();
const ledgers = new Map<string, Ledger>();
const transports = new Map<string, StreamableHTTPServerTransport>();
/** Which user owns each MCP session, so one cannot resume another's. */
const transportOwners = new Map<string, string>();

const IDENTITY_TTL_MS = 60_000;
const identities = new Map<string, { identity: TokenIdentity; checkedAt: number }>();

async function authenticate(token: string): Promise<TokenIdentity | null> {
  const cached = identities.get(token);
  if (cached && Date.now() - cached.checkedAt < IDENTITY_TTL_MS) return cached.identity;

  const identity = await identify(token);
  if (!identity) {
    identities.delete(token);
    return null;
  }
  identities.set(token, { identity, checkedAt: Date.now() });
  return identity;
}

function bearerFrom(req: express.Request): string | null {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}

function unauthorized(res: express.Response, detail: string) {
  res
    .status(401)
    .set("www-authenticate", 'Bearer realm="GitLit"')
    .json({ title: "Unauthorized", status: 401, detail });
}

app.get("/health", (_req, res) => { res.json({ ok: true, service: "mcp" }); });

app.post("/mcp", async (req, res) => {
  const token = bearerFrom(req);
  if (!token) {
    unauthorized(res, "Connect GitLit from Claude, or present a GitLit API token.");
    return;
  }

  const identity = await authenticate(token);
  if (!identity) {
    unauthorized(res, "That token was not accepted. It may be revoked or expired.");
    return;
  }

  // Scope is checked here as well as at the API, so an under-scoped token is
  // refused with an explanation rather than failing later inside a tool.
  if (!identity.scopes.includes("agent:research")) {
    res.status(403).json({
      title: "Forbidden",
      status: 403,
      detail:
        `This token carries [${identity.scopes.join(", ")}] but not agent:research. ` +
        `Mint a token with agent:research and repo:read in GitLit → Settings → Tokens.`,
    });
    return;
  }

  const existingId = req.header("mcp-session-id");
  let transport = existingId ? transports.get(existingId) : undefined;

  if (transport) {
    /**
     * A resumed session must belong to the same user. Without this, knowing
     * an mcp-session-id would be enough to continue someone else's research
     * — including their ledger and their pending architecture commit.
     */
    if (transportOwners.get(existingId!) !== identity.userId) {
      res.status(404).json({ title: "Not found", status: 404, detail: "Unknown session." });
      return;
    }
  } else {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        transports.set(id, transport!);
        transportOwners.set(id, identity.userId);
      },
    });
    transport.onclose = () => {
      if (transport?.sessionId) {
        transports.delete(transport.sessionId);
        transportOwners.delete(transport.sessionId);
      }
    };

    const server = buildMcpServer({
      transport: "http",
      userId: identity.userId,
      gitlit: createGitlitClient(token),
      clientName: req.header("x-client-name") ?? "claude-desktop",
      declaredModel: req.header("x-declared-model") ?? undefined,
      sessions,
      ledgers,
    });
    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

// GET opens the server-to-client SSE stream; DELETE ends the session.
for (const method of ["get", "delete"] as const) {
  app[method]("/mcp", async (req, res) => {
    const token = bearerFrom(req);
    const identity = token ? await authenticate(token) : null;
    if (!identity) {
      unauthorized(res, "Present a GitLit API token.");
      return;
    }
    const id = req.header("mcp-session-id");
    const transport = id ? transports.get(id) : undefined;
    if (!transport || transportOwners.get(id!) !== identity.userId) {
      res.status(404).json({ title: "Not found", status: 404, detail: "Unknown session." });
      return;
    }
    await transport.handleRequest(req, res);
  });
}

const port = Number(process.env.MCP_PORT ?? 4002);
app.listen(port, () => {
  process.stdout.write(`gitlit mcp server listening on :${port}/mcp (streamable http)\n`);
});

export { authenticate, bearerFrom };
