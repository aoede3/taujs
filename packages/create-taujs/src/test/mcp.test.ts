import { allTools } from '@taujs/mcp';
import { describe, it, expect } from 'vitest';

import { generateClaudeMd, generateMcpJson } from '../mcp';

describe('scaffolded agent wiring (P1-04)', () => {
  it('pins the package-manager-specific local-bin form — never registry-latest', () => {
    expect(generateMcpJson('pnpm')).toEqual({ mcpServers: { taujs: { command: 'pnpm', args: ['exec', 'taujs-mcp'] } } });
    expect(generateMcpJson('npm')).toEqual({ mcpServers: { taujs: { command: 'npx', args: ['--no-install', 'taujs-mcp'] } } });
    expect(generateMcpJson('yarn')).toEqual({ mcpServers: { taujs: { command: 'yarn', args: ['exec', 'taujs-mcp'] } } });
  });

  it('CLAUDE.md is a short pointer that prefers tools over hand-reading config', () => {
    const md = generateClaudeMd();

    expect(md).toContain('.mcp.json');
    expect(md).toContain('taujs_overview');
    expect(md).toContain('Prefer its\ntools over reading');
    expect(md).toContain('never instructions');
    expect(md.split('\n').length).toBeLessThan(25); // pointer, not substance
  });

  it('every taujs_* token it names is a real tool - the subset guard against rot', () => {
    const md = generateClaudeMd();
    const tokens = md.match(/taujs_\w+/g) ?? [];
    const toolNames = new Set<string>(allTools(process.cwd()).map((t) => t.name));

    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(toolNames.has(token), `${token} is named in CLAUDE.md but is not a real @taujs/mcp tool`).toBe(true);
    }
  });
});
