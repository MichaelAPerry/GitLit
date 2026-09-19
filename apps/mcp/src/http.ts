import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./server.js";
import { SessionStore } from "./session.js";
import { Ledger } from "./ledger.js";

/**
 * Streamable HTTP transport — the DEFAULT on-ramp (§8.5).
 *
 * Most GitLit authors are novelists, not developers. "Install a CLI" is a large
 * ask; "add GitLit in Claude's connector settings, then ask in plain English"
 * is not. This transport is what most users will ever touch, which is why it
 * ships alongside stdio rather than after it.
 *
 * Auth here is a bearer token placeholder. Production terminates OAuth 2.1
 * (§12.8) and maps the token to a user; the tool layer is already scoped by
 * ctx.userId, so that swap does not reach the tools.
 */
const app = express();
app.use(express.json({ limit: "4mb" }));

// Shared across connections so a dropped socket resumes the same agent session
// rather than silently starting a fresh, empty ledger (§2.5).
const sessions = new SessionStore();
const ledgers = new Map<string, Ledger>();
const transports = new Map<string, StreamableHTTPServerTransport>();

function userFor(req: express.Request): string | null {
  const auth = req.header("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  // Placeholder: real deployments resolve an OAuth token to a user id.
  return process.env.GITLIT_USER_ID ?? "u_demo";
}

app.get("/health", (_req, res) => { res.json({ ok: true, service: "mcp" }); });

app.post("/mcp", async (req, res) => {
  const userId = userFor(req);
  if (!userId) {
    res.status(401).json({
      title: "Unauthorized",
      status: 401,
      detail: "Connect GitLit from Claude to obtain a token.",
    });
    return;
  }

  const existingId = req.header("mcp-session-id");
  let transport = existingId ? transports.get(existingId) : undefined;

  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => { transports.set(id, transport!); },
    });
    transport.onclose = () => {
      if (transport?.sessionId) transports.delete(transport.sessionId);
    };
    const server = buildMcpServer({
      transport: "http",
      userId,
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
    const id = req.header("mcp-session-id");
    const transport = id ? transports.get(id) : undefined;
    if (!transport) { res.status(404).send("Unknown session"); return; }
    await transport.handleRequest(req, res);
  });
}

const port = Number(process.env.MCP_PORT ?? 4002);
app.listen(port, () => {
  process.stdout.write(`gitlit mcp server listening on :${port}/mcp (streamable http)\n`);
});
