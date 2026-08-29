// @vitest-environment node
//
// RFC 0014 M6 - the packed-artifact leg (00-EVIDENCE-PLAN.md M6: "the §1 recipe compiled VERBATIM
// under the project's strict tsconfig against the packed .d.ts"). fixtures/rfc-0014-recipe's own
// `typecheck` already compiles the recipe against the WORKSPACE-linked @taujs/server (its
// `exports` map resolving straight to `dist/*.d.ts`) - this test goes one step further and
// typechecks the SAME recipe source against a REAL `npm pack` extraction, exactly what a consumer
// installs. This is the leg that would catch a broken `files` allow-list or export map even if the
// workspace link stayed green (mirrors packages/create-taujs/src/test/lifecycle.test.ts's pack
// approach: pack -> install the tarball into a throwaway consumer project -> exercise it for real).

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)); // packages/server/src/test -> repo root
const SERVER_DIR = path.join(REPO_ROOT, 'packages', 'server');
const RECIPE_SOURCE = path.join(REPO_ROOT, 'fixtures', 'rfc-0014-recipe', 'src', 'recipe.ts');

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('RFC 0014 M6 - packed-artifact leg', () => {
  it('the §1 recipe compiles, strict, zero errors, against a REAL npm-packed @taujs/server tarball', () => {
    if (!existsSync(path.join(SERVER_DIR, 'dist'))) {
      throw new Error('@taujs/server is not built - run `pnpm -r build` first');
    }
    expect(existsSync(RECIPE_SOURCE), `recipe source missing at ${RECIPE_SOURCE}`).toBe(true);

    // 1: pack, exactly as a consumer receives it.
    const packDest = mkdtempSync(path.join(tmpdir(), 'taujs-rfc0014-pack-'));
    scratchDirs.push(packDest);
    execFileSync('npm', ['pack', '--pack-destination', packDest], { cwd: SERVER_DIR, stdio: 'pipe' });
    const tarball = readdirSync(packDest).find((f) => f.endsWith('.tgz'));
    if (!tarball) throw new Error('npm pack produced no tarball');
    const tarballPath = path.join(packDest, tarball);

    // 2: a throwaway consumer project installing ONLY the packed tarball plus ordinary registry
    // deps (fastify, typescript) - never the workspace source, never a `workspace:*` link.
    const projectDir = mkdtempSync(path.join(tmpdir(), 'taujs-rfc0014-pack-project-'));
    scratchDirs.push(projectDir);

    writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify(
        {
          name: 'rfc-0014-pack-check',
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

    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: projectDir, stdio: 'pipe' });

    // Resolution goes through the packed export map, not a source path.
    const resolved = execFileSync(process.execPath, ['--input-type=module', '-e', "console.log(import.meta.resolve('@taujs/server/config'))"], {
      cwd: projectDir,
      encoding: 'utf8',
    });
    expect(resolved).toContain(path.join('@taujs', 'server', 'dist', 'Config.js'));

    // 3: the SAME recipe source, copied verbatim into the consumer project.
    cpSync(RECIPE_SOURCE, path.join(projectDir, 'recipe.ts'));
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
          include: ['recipe.ts'],
        },
        null,
        2,
      ),
    );

    // 4: typecheck against the EXTRACTED tarball's declarations - exit 0 required.
    let output = '';
    try {
      output = execFileSync('npx', ['tsc', '--noEmit', '-p', '.'], { cwd: projectDir, encoding: 'utf8' });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      throw new Error(`tsc against the packed tarball failed:\n${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message}`);
    }
    expect(output.trim()).toBe('');
  }, 180_000);
});
