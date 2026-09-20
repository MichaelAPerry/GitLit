#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "./server.js";
import { createGitlitClient, identify } from "./gitlit-client.js";

/**
 * stdio transport — how Claude Code connects (§8.5).
 *
 *   claude mcp add gitlit -- npx -y @gitlit/mcp
 *
 * The author runs this process, so their own token is the right credential.
 * It is resolved at startup rather than trusted: a stale or revoked token
 * should fail here with an explanation, not at the first tool call with a
 * 401 the agent has to interpret.
 *
 * Nothing may be written to stdout except protocol frames, so all output
 * goes to stderr. A stray console.log corrupts the session.
 */
const token = process.env.GITLIT_API_TOKEN;
if (!token) {
  process.stderr.write(
    "GITLIT_API_TOKEN is not set.\n" +
    "Create a token in GitLit (Settings → Tokens) with the agent:research and\n" +
    "repo:read scopes, then set it for this server.\n",
  );
  process.exit(1);
}

const identity = await identify(token);
if (!identity) {
  process.stderr.write(
    "GITLIT_API_TOKEN was not accepted. It may be revoked, expired, or for a\n" +
    "different GitLit instance. Check GITLIT_API_URL and mint a new token.\n",
  );
  process.exit(1);
}

if (!identity.scopes.includes("agent:research")) {
  process.stderr.write(
    `This token carries [${identity.scopes.join(", ")}] but not agent:research,\n` +
    "so it cannot run research or commit an architecture. Mint one that does.\n",
  );
  process.exit(1);
}

const server = buildMcpServer({
  transport: "stdio",
  userId: identity.userId,
  gitlit: createGitlitClient(token),
  clientName: "claude-code",
  declaredModel: process.env.GITLIT_DECLARED_MODEL,
});

await server.connect(new StdioServerTransport());
process.stderr.write(`gitlit mcp server ready (stdio) as @${identity.handle}\n`);
