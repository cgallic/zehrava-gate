#!/usr/bin/env node
// Gate MCP server (issue #9) — exposes the tools in tools.js over stdio for
// any MCP-compatible client (Claude Desktop, Claude Code, other MCP hosts).
// Configure via env vars:
//   GATE_ENDPOINT   Gate server base URL, default http://localhost:3001
//   GATE_API_KEY    Gate agent API key (register one via POST /v1/agents/register)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TOOLS } from './tools.js';

async function main() {
  const server = new McpServer({ name: 'zehrava-gate', version: '0.1.0' });
  const config = {}; // resolved from GATE_ENDPOINT / GATE_API_KEY at request time

  for (const tool of TOOLS) {
    server.tool(tool.name, tool.description, tool.schema, async (args) => {
      const result = await tool.handler(args, config);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[gate-mcp] fatal error:', err);
  process.exit(1);
});
