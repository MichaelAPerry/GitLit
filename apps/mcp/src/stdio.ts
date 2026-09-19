#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "./server.js";

/**
 * stdio transport — how Claude Code connects (§8.5).
 *
 *   claude mcp add gitlit -- npx -y @gitlit/mcp
 *
 * Nothing may be written to stdout except protocol frames, so any logging goes
 * to stderr. A stray console.log here corrupts the session.
 */
const server = buildMcpServer({
  transport: "stdio",
  userId: process.env.GITLIT_USER_ID ?? "u_demo",
  clientName: "claude-code",
  declaredModel: process.env.GITLIT_DECLARED_MODEL,
});

await server.connect(new StdioServerTransport());
process.stderr.write("gitlit mcp server ready (stdio)\n");
