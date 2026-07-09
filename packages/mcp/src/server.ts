import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import pkg from '../package.json';
import { structuralTools } from './tools/structural';

import type { ToolDefinition } from './toolkit';

export const allTools = (root: string): ToolDefinition[] => [...structuralTools(root)];

// Tool results are JSON text content: agents parse structure, humans read it too.
const toContent = (result: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  ...(result.ok === false ? { isError: true as const } : {}),
});

export const createTaujsMcpServer = (root: string = process.cwd()): McpServer => {
  const server = new McpServer({ name: 'taujs-mcp', version: pkg.version });

  for (const tool of allTools(root)) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.inputSchema as never }, ((
      args: Record<string, unknown>,
    ) => toContent(tool.handler(args ?? {}))) as never);
  }

  return server;
};
