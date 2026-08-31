// @vitest-environment node
//
// Packed-boundary proof for `defineRoutes`/`defineApp` composition (followup:
// const-preserving-config-composition). Mirrors the pack -> throwaway-project -> tsc mechanics of
// Rfc0014RecipePack.test.ts: pack @taujs/server for real, install ONLY the tarball (plus ordinary
// registry deps) into a throwaway consumer project - never the workspace source, never a
// `workspace:*` link - and typecheck strict, zero errors. The consumer here is assembled from
// template literals rather than a checked-in fixture directory, and covers exactly: both helpers
// imported from the packed '@taujs/server/config' entry, spread composition of two `defineRoutes`
// fragments inside an inline app, one `defineApp` fragment composed alongside it, and exact
// path/data inference (including a wrong-path lookup collapsing to `never`) against the packed
// public declarations. `renderer` is satisfied by a `declare`d `TaujsRendererContribution`, so no
// renderer package is installed - this leg proves the config surface alone. The source-level
// regression on the same helpers (no packed boundary, no `as const`, plus the documented
// degradation case) lives in PublicConfigComposition.test-d.ts.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)); // packages/server/src/test -> repo root
const SERVER_DIR = path.join(REPO_ROOT, 'packages', 'server');

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const mkScratch = (prefix: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
};

// --- The throwaway consumer's own source - template literals, no checked-in fixture directory. ---

const AUTH_ROUTES = `import { defineRoutes } from '@taujs/server/config';

export const authRoutes = defineRoutes([
  { path: '/login', attr: { render: 'ssr', data: async () => ({ userId: 'u1' }) } },
  { path: '/register', attr: { render: 'ssr', data: async () => ({ ok: true }) } },
]);
`;

const CATALOG_ROUTES = `import { defineRoutes } from '@taujs/server/config';

export const catalogRoutes = defineRoutes([
  { path: '/catalog/:id', attr: { render: 'ssr', data: async () => ({ sku: 'x', price: 10 }) } },
]);
`;

const ADMIN_APP = `import type { TaujsRendererContribution } from '@taujs/server/config';
import { defineApp } from '@taujs/server/config';

declare const renderer: TaujsRendererContribution;

export const adminApp = defineApp({
  appId: 'admin',
  entryPoint: 'admin',
  renderer,
  routes: [{ path: '/admin/*', attr: { render: 'ssr', data: async () => ({ role: 'owner' as const }) } }],
});
`;

const ROOT_CONFIG = `import type { TaujsRendererContribution } from '@taujs/server/config';
import { defineConfig } from '@taujs/server/config';
import { authRoutes } from './authRoutes';
import { catalogRoutes } from './catalogRoutes';
import { adminApp } from './adminApp';

declare const renderer: TaujsRendererContribution;

export default defineConfig({
  apps: [
    {
      appId: 'web',
      entryPoint: 'client',
      renderer,
      routes: [...authRoutes, ...catalogRoutes],
    },
    adminApp,
  ],
});
`;

const SELF_CHECK = `import type { RouteContext, RouteData } from '@taujs/server/config';
import config from './taujs.config';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type Ctx = RouteContext<typeof config>;

// Exact appId union: 'web' is captured by defineConfig's own const generic (inline app), 'admin'
// by the defineApp fragment.
type _AppId = Expect<Equal<Ctx['appId'], 'web' | 'admin'>>;

// Exact path union across the [...authRoutes, ...catalogRoutes] spread plus the defineApp route.
type _Path = Expect<Equal<Ctx['path'], '/login' | '/register' | '/catalog/:id' | '/admin/*'>>;

// RouteData exact for a spread-fragment route and for the defineApp fragment's own route.
type _AuthRouteData = Expect<Equal<RouteData<typeof config, '/login'>, { userId: string }>>;
type _AdminRouteData = Expect<Equal<RouteData<typeof config, '/admin/*'>, { role: 'owner' }>>;

// A path no fragment declares resolves to never, not a silently wide type.
type _WrongPath = Expect<Equal<RouteData<typeof config, '/nope'>, never>>;
`;

const PROJECT_FILES: Record<string, string> = {
  'authRoutes.ts': AUTH_ROUTES,
  'catalogRoutes.ts': CATALOG_ROUTES,
  'adminApp.ts': ADMIN_APP,
  'taujs.config.ts': ROOT_CONFIG,
  'selfCheck.ts': SELF_CHECK,
};

let tarballPath: string;
let projectDir: string;
let tscStatus = 1;
let tscOutput = '';

// Freshness guard, same semantics as fixtures/test-support's assertWorkspacePackagesBuilt (which
// cannot be imported here without a cross-package devDependency): this test packs dist, so a
// stale build would provide false evidence. Fail with an actionable instruction instead.
const newestSourceMtime = (directory: string): number => {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'test' || entry.name === 'node_modules') continue;
    const candidate = path.join(directory, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestSourceMtime(candidate) : statSync(candidate).mtimeMs);
  }
  return newest;
};

describe('packed config-composition consumer - defineRoutes/defineApp against a REAL npm-packed @taujs/server tarball', () => {
  beforeAll(() => {
    const builtConfigDts = path.join(SERVER_DIR, 'dist', 'Config.d.ts');
    if (!existsSync(builtConfigDts) || statSync(builtConfigDts).mtimeMs < newestSourceMtime(path.join(SERVER_DIR, 'src'))) {
      throw new Error('@taujs/server dist is absent or older than src - run `pnpm --filter @taujs/server build` before this test packs it');
    }

    // 1: pack, exactly as a consumer receives it.
    const packDest = mkScratch('taujs-config-composition-pack-');
    execFileSync('npm', ['pack', '--pack-destination', packDest], { cwd: SERVER_DIR, stdio: 'pipe' });
    const tarball = readdirSync(packDest).find((f) => f.endsWith('.tgz'));
    if (!tarball) throw new Error('npm pack produced no tarball');
    tarballPath = path.join(packDest, tarball);

    // 2: a throwaway consumer project installing ONLY the packed tarball plus ordinary registry
    // deps (fastify, typescript) - never the workspace source, never a `workspace:*` link.
    projectDir = mkScratch('taujs-config-composition-project-');
    writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify(
        {
          name: 'config-composition-pack-check',
          private: true,
          type: 'module',
          dependencies: {
            '@taujs/server': `file:${tarballPath}`,
            fastify: '^5.8.5',
          },
          devDependencies: {
            typescript: '^5.5.4',
            '@types/node': '^20.14.9',
          },
        },
        null,
        2,
      ),
    );

    for (const [name, content] of Object.entries(PROJECT_FILES)) writeFileSync(path.join(projectDir, name), content);

    writeFileSync(
      path.join(projectDir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            moduleDetection: 'force',
            lib: ['ES2022'],
            strict: true,
            noImplicitOverride: true,
            noUncheckedIndexedAccess: true,
            verbatimModuleSyntax: true,
            esModuleInterop: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true,
            resolveJsonModule: true,
            isolatedModules: true,
            allowImportingTsExtensions: true,
            noEmit: true,
            types: ['node'],
          },
          include: ['*.ts'],
        },
        null,
        2,
      ),
    );

    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: projectDir, stdio: 'pipe' });

    // 3: typecheck against the EXTRACTED tarball's declarations. Non-throwing so both this and the
    // dist-declarations check below can each fail on their own terms.
    const result = spawnSync('npx', ['tsc', '--noEmit', '-p', '.', '--pretty', 'false'], { cwd: projectDir, encoding: 'utf8' });
    tscStatus = result.status ?? 1;
    tscOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  }, 180_000);

  it('packs a fresh @taujs/server tarball, and the installed dist/Config.d.ts declares defineRoutes and defineApp', () => {
    expect(existsSync(tarballPath)).toBe(true);
    const configDts = readFileSync(path.join(projectDir, 'node_modules', '@taujs', 'server', 'dist', 'Config.d.ts'), 'utf8');
    expect(configDts).toContain('defineRoutes');
    expect(configDts).toContain('defineApp');
  });

  it(
    'compiles the composed consumer, strict, zero errors, against the packed tarball: spread composition, ' +
      'the defineApp fragment, exact path/data inference, and a wrong-path RouteData of never',
    () => {
      expect(tscOutput.trim(), tscOutput).toBe('');
      expect(tscStatus).toBe(0);
    },
  );
});
