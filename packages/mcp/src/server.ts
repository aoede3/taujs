import { McpServer } from '@modelcontextprotocol/server';

import pkg from '../package.json';
import { skills } from './skills';
import { contractTools } from './tools/contracts';
import { runtimeTools } from './tools/runtime';
import { structuralTools } from './tools/structural';

import type { ToolDefinition, ToolResult } from './toolkit';

export const allTools = (root: string): ToolDefinition[] => [...structuralTools(root), ...runtimeTools(root), ...contractTools(root)];

// Tool results are JSON text content: agents parse structure, humans read it too. The same
// `result` object backs both content shapes - structuredContent and the text block never drift.
const toContent = (result: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  structuredContent: result,
  ...(result.ok === false ? { isError: true as const } : {}),
});

const TOOL_FAILURE_MESSAGE_CAP = 500;

const isPromise = (value: unknown): value is Promise<ToolResult> => typeof (value as { then?: unknown } | null)?.then === 'function';

// Every tool answers in the ok/reason envelope - except when it threw, and then the agent got prose
// with no `reason` to act on. The SDK does catch a throw into `isError` text, so nothing leaked and
// no protocol error was raised; what was missing was the structure every other failure has. The
// full error goes to STDERR (stdout is the protocol channel on a stdio server) and only a bounded
// message returns.
const failure = (name: string, err: unknown) => {
  console.error(`[taujs-mcp] ${name} failed:`, err);
  const message = err instanceof Error ? err.message : String(err);

  return toContent({ ok: false, reason: 'tool_failure', message: message.slice(0, TOOL_FAILURE_MESSAGE_CAP) });
};

// Exported for its own cells: this is the one place every tool's throw is converted into the
// envelope, and a guard nothing exercises is a guard nobody can trust. Not re-exported from
// index.ts - it is not public surface.
export const runTool = (tool: ToolDefinition, args: Record<string, unknown>) => {
  try {
    const result = tool.handler(args ?? {}) as ToolResult | Promise<ToolResult>;

    // Handlers are synchronous today. A rejection is caught anyway, because a guard that covers
    // only synchronous throws stops covering the handler the day one becomes async - silently, and
    // exactly when nobody is looking for it.
    return isPromise(result) ? result.then(toContent, (err: unknown) => failure(tool.name, err)) : toContent(result);
  } catch (err) {
    return failure(tool.name, err);
  }
};

export const createTaujsMcpServer = (root: string = process.cwd()): McpServer => {
  const server = new McpServer({ name: 'taujs-mcp', version: pkg.version });

  for (const tool of allTools(root)) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.inputSchema }, (args) => runTool(tool, args));
  }

  // Skills ride the MCP prompts surface: versioned with the package, zero per-project files.
  for (const skill of skills) {
    server.registerPrompt(skill.name, { title: skill.title, description: skill.description }, () => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: skill.text } }],
    }));
  }

  return server;
};
