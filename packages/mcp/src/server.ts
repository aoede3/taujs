import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import pkg from '../package.json';
import { skills } from './skills';
import { runtimeTools } from './tools/runtime';
import { structuralTools } from './tools/structural';

import type { ToolDefinition } from './toolkit';

export const allTools = (root: string): ToolDefinition[] => [...structuralTools(root), ...runtimeTools(root)];

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

  // Skills ride the MCP prompts surface: versioned with the package, zero per-project files.
  for (const skill of skills) {
    server.registerPrompt(skill.name, { title: skill.title, description: skill.description }, () => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: skill.text } }],
    }));
  }

  return server;
};
