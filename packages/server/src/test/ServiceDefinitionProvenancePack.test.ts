// @vitest-environment node
//
// Packed-boundary proof for service definition provenance. The graph may expose only the
// project-relative file where defineService actually ran. It must preserve a defining module
// through a re-export, report emitted JavaScript after compilation rather than inventing a
// TypeScript source path, and say unknown for a hand-built registry entry.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SERVER_DIR = path.join(REPO_ROOT, 'packages', 'server');
const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const newestSourceMtime = (directory: string): number => {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'test' || entry.name === 'node_modules') continue;
    const candidate = path.join(directory, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestSourceMtime(candidate) : statSync(candidate).mtimeMs);
  }
  return newest;
};

const DIRECT_SERVICE = `import { defineService } from '@taujs/server/config';

export const direct = defineService({ greet: async (_params: {}) => ({ ok: true }) });
`;

const REEXPORTED_SERVICE = `import { defineService } from '@taujs/server/config';

export const reexported = defineService({ greet: async (_params: {}) => ({ ok: true }) });
`;

const BARREL = `export { reexported } from './reexported.js';
`;

const RUN = `import { createRequestGraph } from '@taujs/server';
import { defineServiceRegistry } from '@taujs/server/config';
import { direct } from './services/direct.js';
import { reexported } from './services/index.js';

const handwritten = { greet: async (_params: {}, _ctx: unknown) => ({ ok: true }) };
const registry = defineServiceRegistry({ direct, handwritten, reexported });
const config = { apps: [{ appId: 'web', entryPoint: '', routes: [] }] };
const graph = createRequestGraph(config, {
  source: 'boot',
  emittedAt: '2026-09-25T00:00:00.000Z',
  serviceRegistry: registry,
  projectRoot: process.env.TAUJS_PROVENANCE_ROOT ?? process.cwd(),
});

console.log(JSON.stringify(graph.services));
`;

type ServiceRow = { name: string; definitionLocation?: { status: 'known'; path: string } | { status: 'unknown' } };

let projectDir: string;
let sourceRows: ServiceRow[];
let builtRows: ServiceRow[];
let sourceOutput = '';
let builtOutput = '';

const run = (command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  expect(result.status, output).toBe(0);
  return String(result.stdout).trim();
};

describe('packed service definition provenance', () => {
  beforeAll(() => {
    const builtConfigDts = path.join(SERVER_DIR, 'dist', 'Config.d.ts');
    if (!existsSync(builtConfigDts) || statSync(builtConfigDts).mtimeMs < newestSourceMtime(path.join(SERVER_DIR, 'src'))) {
      throw new Error('@taujs/server dist is absent or older than src - run `pnpm --filter @taujs/server build` before this test packs it');
    }

    const packDest = mkdtempSync(path.join(tmpdir(), 'taujs-service-provenance-pack-'));
    scratchDirs.push(packDest);
    execFileSync('npm', ['pack', '--pack-destination', packDest], { cwd: SERVER_DIR, stdio: 'pipe' });
    const tarball = readdirSync(packDest).find((file) => file.endsWith('.tgz'));
    if (!tarball) throw new Error('npm pack produced no tarball');

    projectDir = mkdtempSync(path.join(tmpdir(), 'taujs-service-provenance-project-'));
    scratchDirs.push(projectDir);
    mkdirSync(path.join(projectDir, 'src', 'services'), { recursive: true });
    writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify(
        {
          name: 'service-provenance-pack-check',
          private: true,
          type: 'module',
          dependencies: { '@taujs/server': `file:${path.join(packDest, tarball)}`, fastify: '^5.8.5' },
          devDependencies: { '@types/node': '^20.14.9', tsx: '^4.19.3', typescript: '^5.5.4' },
        },
        null,
        2,
      ),
    );
    writeFileSync(path.join(projectDir, 'src', 'services', 'direct.ts'), DIRECT_SERVICE);
    writeFileSync(path.join(projectDir, 'src', 'services', 'reexported.ts'), REEXPORTED_SERVICE);
    writeFileSync(path.join(projectDir, 'src', 'services', 'index.ts'), BARREL);
    writeFileSync(path.join(projectDir, 'src', 'run.ts'), RUN);
    writeFileSync(
      path.join(projectDir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            skipLibCheck: true,
            rootDir: 'src',
            outDir: 'dist',
            types: ['node'],
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    );

    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: projectDir, stdio: 'pipe' });
    sourceOutput = run('npx', ['tsx', 'src/run.ts'], projectDir);
    sourceRows = JSON.parse(sourceOutput) as ServiceRow[];
    run('npx', ['tsc', '-p', '.', '--pretty', 'false'], projectDir);
    builtOutput = run(process.execPath, ['dist/run.js'], projectDir);
    builtRows = JSON.parse(builtOutput) as ServiceRow[];
  }, 180_000);

  it('attributes direct and re-exported definitions to their source modules under tsx', () => {
    expect(sourceRows.map(({ name, definitionLocation }) => ({ name, definitionLocation }))).toEqual([
      { name: 'direct', definitionLocation: { status: 'known', path: 'src/services/direct.ts' } },
      { name: 'handwritten', definitionLocation: { status: 'unknown' } },
      { name: 'reexported', definitionLocation: { status: 'known', path: 'src/services/reexported.ts' } },
    ]);
  });

  it('reports emitted JavaScript after compilation and never invents an original source path', () => {
    expect(builtRows.map(({ name, definitionLocation }) => ({ name, definitionLocation }))).toEqual([
      { name: 'direct', definitionLocation: { status: 'known', path: 'dist/services/direct.js' } },
      { name: 'handwritten', definitionLocation: { status: 'unknown' } },
      { name: 'reexported', definitionLocation: { status: 'known', path: 'dist/services/reexported.js' } },
    ]);
  });

  it('emits no absolute scratch path and is deterministic for each execution mode', () => {
    expect(sourceOutput).not.toContain(projectDir);
    expect(builtOutput).not.toContain(projectDir);
    expect(run('npx', ['tsx', 'src/run.ts'], projectDir)).toBe(sourceOutput);
    expect(run(process.execPath, ['dist/run.js'], projectDir)).toBe(builtOutput);
  });

  it('fails closed when every captured definition is outside the supplied root', () => {
    const outsideRows = JSON.parse(
      run('npx', ['tsx', 'src/run.ts'], projectDir, { TAUJS_PROVENANCE_ROOT: path.join(projectDir, 'isolated-root') }),
    ) as ServiceRow[];

    expect(outsideRows.map(({ name, definitionLocation }) => ({ name, definitionLocation }))).toEqual([
      { name: 'direct', definitionLocation: { status: 'unknown' } },
      { name: 'handwritten', definitionLocation: { status: 'unknown' } },
      { name: 'reexported', definitionLocation: { status: 'unknown' } },
    ]);
  });
});
