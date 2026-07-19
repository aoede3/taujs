// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The package's REAL export - the same entry the shipped CLI calls to plan its output - rather than
// the individual `generate*()` template functions.
import { planFiles, type Framework, type ProjectConfig } from '../index.js';

/**
 * Generation is exercised through the package's real export and the shipped binary's argument
 * handling, never by importing template functions directly.
 *
 * NB the shipped CLI cannot be driven END-TO-END headlessly today: after `--framework` it still
 * prompts for a package manager and for install-now, and `prompts` requires a TTY (piped stdin is
 * not consumed, so the process exits without writing). There is no `--package-manager` / `--yes`
 * flag. So the CLI is covered here for the surface it CAN expose non-interactively - framework
 * validation - and the file plan is covered through `planFiles`, which is what the CLI writes.
 * Closing that gap needs either new CLI flags or a PTY harness; it is recorded in decisions.md as
 * an open item rather than worked around with a fake.
 */
const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

const cfg = (framework: Framework): ProjectConfig => ({ projectName: 'demo-app', packageManager: 'npm', installDeps: false, framework });

const generate = (framework: Framework) => {
  const files = new Map<string, string>();
  for (const entry of planFiles(cfg(framework))) {
    files.set(entry.path, 'json' in entry ? JSON.stringify(entry.json, null, 2) : entry.content);
  }

  const read = (rel: string) => {
    const content = files.get(rel);
    if (content === undefined) throw new Error(`generated file missing: ${rel}`);

    return content;
  };

  return { dir: '', read, has: (rel: string) => files.has(rel) };
};

describe('create-taujs CLI - the shipped binary knows about Solid', () => {
  it('the built CLI exists and accepts --framework=solid without a validation error', () => {
    expect(existsSync(CLI), `CLI dist missing at ${CLI} - run \`pnpm build\` first`).toBe(true);

    const dir = mkdtempSync(path.join(tmpdir(), 'taujs-cli-'));
    try {
      // With no TTY the CLI reaches the package-manager prompt and exits without writing, so this
      // asserts on the VALIDATION output: a known framework produces no rejection message.
      const output = execFileSync(process.execPath, [CLI, 'demo-app', '--framework=solid'], {
        cwd: dir,
        stdio: 'pipe',
        encoding: 'utf8',
      });

      expect(output).not.toContain('Invalid framework');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the built CLI REJECTS an unknown framework, and names solid as valid', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'taujs-cli-'));
    try {
      // An invalid framework is a non-zero exit, so execFileSync THROWS - the message is on the
      // error's captured stdout.
      let output = '';
      try {
        output = execFileSync(process.execPath, [CLI, 'demo-app', '--framework=svelte'], { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
        expect.unreachable('the CLI should reject an unknown framework with a non-zero exit');
      } catch (e) {
        output = String((e as { stdout?: string }).stdout ?? '');
      }

      expect(output).toContain('Invalid framework');
      expect(output).toContain('solid'); // the valid list now includes it
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('create-taujs - Solid generation (through the package export)', () => {
  it('plans a complete project', () => {
    const { has } = generate('solid');

    expect(has('package.json')).toBe(true);
    expect(has('taujs.config.ts')).toBe(true);
  });

  it('declares renderer: solidRenderer({ project }) and NO raw managed compiler plugin', () => {
    const { read } = generate('solid');
    {
      const config = read('taujs.config.ts');

      expect(config).toContain("import { solidRenderer } from '@taujs/solid/renderer';");
      expect(config).toContain("renderer: solidRenderer({ project: './tsconfig.solid.json' }),");

      // The managed compiler is supplied internally with `ssr: true` forced. A generated app must
      // never add vite-plugin-solid to `plugins` itself - that would be a second, unmanaged
      // compiler with the wrong transform mode.
      expect(config).not.toContain('vite-plugin-solid');
      expect(config).not.toContain('pluginSolid');
      expect(config).not.toContain('scopedPluginSolid');
    }
  });

  it('writes a DISJOINT compiler tsconfig that claims only the client TSX', () => {
    const { read } = generate('solid');
    {
      const compilerTsconfig = JSON.parse(read('tsconfig.solid.json')) as {
        compilerOptions: Record<string, unknown>;
        include: string[];
      };

      expect(compilerTsconfig.include).toEqual(['src/client/**/*.tsx']);
      expect(compilerTsconfig.compilerOptions.jsx).toBe('preserve');
      expect(compilerTsconfig.compilerOptions.jsxImportSource).toBe('solid-js');

      // Disjoint: it must not claim the server tree or the config file.
      expect(compilerTsconfig.include.some((glob) => glob.includes('server'))).toBe(false);
      expect(compilerTsconfig.include.some((glob) => glob.includes('taujs.config'))).toBe(false);
    }
  });

  it('generates the server createRenderer and client hydrateApp against a SHARED renderId', () => {
    const { read } = generate('solid');
    {
      const entryServer = read('src/client/entry-server.tsx');
      const entryClient = read('src/client/entry-client.tsx');
      const renderId = read('src/client/renderId.ts');

      expect(entryServer).toContain("import { createRenderer } from '@taujs/solid';");
      expect(entryServer).toContain('export const { renderSSR, renderStream } = createRenderer({');
      expect(entryClient).toContain("import { hydrateApp } from '@taujs/solid';");

      // The renderId is ONE shared constant imported by BOTH entries - a literal duplicated across
      // two files is a hydration bug waiting to happen.
      expect(renderId).toContain('export const RENDER_ID');
      expect(entryServer).toContain("import { RENDER_ID } from './renderId';");
      expect(entryClient).toContain("import { RENDER_ID } from './renderId';");
      expect(entryServer).toContain('renderId: RENDER_ID,');
      expect(entryClient).toContain('renderId: RENDER_ID,');
    }
  });

  it('uses only the frozen hydrateApp options - none of React\'s extras', () => {
    const { read } = generate('solid');
    {
      const entryClient = read('src/client/entry-client.tsx');

      for (const reactOnly of ['appComponent:', 'enableDebug', 'dataKey', 'onStart', 'onSuccess', 'logger']) {
        expect(entryClient, `${reactOnly} is not part of Solid's frozen hydrateApp surface`).not.toContain(reactOnly);
      }
      expect(entryClient).toContain('app: () => <App />');
    }
  });

  it('declares the Solid dependency set and externals @taujs/solid in the server bundle', () => {
    const { read } = generate('solid');
    {
      const pkg = JSON.parse(read('package.json')) as {
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
        scripts: Record<string, string>;
      };

      expect(pkg.dependencies['@taujs/solid']).toBeTruthy();
      expect(pkg.dependencies['solid-js']).toBeTruthy();
      expect(pkg.devDependencies['vite-plugin-solid']).toBeTruthy();
      expect(pkg.dependencies['react']).toBeUndefined();
      expect(pkg.dependencies['vue']).toBeUndefined();
      expect(pkg.scripts['build:server']).toContain('--external:@taujs/solid');
    }
  });

  it('the root tsconfig preserves JSX for Solid rather than using React\'s runtime', () => {
    const { read } = generate('solid');
    {
      const tsconfig = JSON.parse(read('tsconfig.json')) as { compilerOptions: Record<string, unknown> };

      expect(tsconfig.compilerOptions.jsx).toBe('preserve');
      expect(tsconfig.compilerOptions.jsxImportSource).toBe('solid-js');
    }
  });

  it('React and Vue generation are UNCHANGED by the Solid addition', () => {
    for (const framework of ['react', 'vue'] as Framework[]) {
      const { read, has } = generate(framework);
      {
        expect(has('tsconfig.solid.json'), `${framework} must not get Solid's compiler tsconfig`).toBe(false);
        expect(read('taujs.config.ts')).not.toContain('solidRenderer');
        expect(read('taujs.config.ts')).toContain(framework === 'vue' ? 'vueRenderer(' : 'reactRenderer(');
      }
    }
  });
});
