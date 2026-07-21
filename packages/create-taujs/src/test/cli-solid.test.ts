// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

  it("uses only the frozen hydrateApp options - none of React's extras", () => {
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

  it("the root tsconfig preserves JSX for Solid rather than using React's runtime", () => {
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

describe('create-taujs CLI - the frozen non-interactive interface', () => {
  const run = (args: string[], cwd: string) => {
    try {
      const stdout = execFileSync(process.execPath, [CLI, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });

      return { code: 0, stdout };
    } catch (e) {
      const err = e as { status?: number; stdout?: string };

      return { code: err.status ?? 1, stdout: String(err.stdout ?? '') };
    }
  };

  const scratch = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'taujs-flags-'));

    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  };

  it('generates with NO TTY when name, framework, package manager and install choice are all supplied', () => {
    const { dir, cleanup } = scratch();
    try {
      // stdin is 'ignore' - there is no TTY and nothing to read. This is the CI/agent contract.
      const { code } = run(['my-app', '--framework', 'solid', '--package-manager', 'pnpm', '--no-install'], dir);

      expect(code).toBe(0);
      expect(existsSync(path.join(dir, 'my-app', 'taujs.config.ts'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('rejects --install together with --no-install, BEFORE creating anything', () => {
    const { dir, cleanup } = scratch();
    try {
      const { code, stdout } = run(['my-app', '--framework', 'solid', '--package-manager', 'npm', '--install', '--no-install'], dir);

      expect(code).toBe(1);
      expect(stdout).toContain('--install and --no-install are mutually exclusive');
      expect(existsSync(path.join(dir, 'my-app')), 'a rejected invocation must leave nothing on disk').toBe(false);
    } finally {
      cleanup();
    }
  });

  it('rejects an invalid package manager, BEFORE creating anything', () => {
    const { dir, cleanup } = scratch();
    try {
      const { code, stdout } = run(['my-app', '--framework', 'solid', '--package-manager', 'bun', '--no-install'], dir);

      expect(code).toBe(1);
      expect(stdout).toContain('Invalid package manager "bun"');
      expect(stdout).toContain('npm, pnpm, yarn');
      expect(existsSync(path.join(dir, 'my-app'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('accepts each valid package manager', () => {
    for (const pm of ['npm', 'pnpm', 'yarn']) {
      const { dir, cleanup } = scratch();
      try {
        expect(run(['my-app', '--framework', 'solid', '--package-manager', pm, '--no-install'], dir).code, `--package-manager ${pm}`).toBe(0);
      } finally {
        cleanup();
      }
    }
  });

  it('OMITTED options still prompt - interactive DX is unchanged', () => {
    const { dir, cleanup } = scratch();
    try {
      // No --package-manager: the prompt is reached (and, with no TTY, the run stops there).
      expect(run(['my-app', '--framework', 'solid', '--no-install'], dir).stdout).toContain('Package manager:');
      // No install flag: that prompt is reached instead.
      expect(run(['my-app', '--framework', 'solid', '--package-manager', 'npm'], dir).stdout).toContain('Install dependencies now?');
    } finally {
      cleanup();
    }
  });

  it('an explicit option suppresses ONLY its own prompt', () => {
    const { dir, cleanup } = scratch();
    try {
      const { stdout } = run(['my-app', '--framework', 'solid', '--package-manager', 'npm', '--no-install'], dir);

      expect(stdout).not.toContain('Package manager:');
      expect(stdout).not.toContain('Install dependencies now?');
      expect(stdout).not.toContain('Framework:');
    } finally {
      cleanup();
    }
  });

  it('there is no --yes flag', () => {
    // Deliberate: its defaults, and whether it would install from the network, would be ambiguous.
    expect(readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')).not.toContain("'--yes'");
  });
});

describe('scaffolder baseline corrections - asserted for EVERY framework', () => {
  const frameworks: Framework[] = ['react', 'vue', 'solid'];

  for (const framework of frameworks) {
    it(`${framework}: types.d.ts AUGMENTS @taujs/server/config rather than shadowing it`, () => {
      const { read } = generate(framework);
      const augmentation = read('src/server/types.d.ts');

      // Without the leading import, `declare module` is an AMBIENT MODULE DECLARATION that
      // REPLACES the real module - erasing `defineConfig`/`defineService`/`defineServiceRegistry`
      // (TS2305) and dropping route `data` callbacks to implicit `any` (TS7006). No generated
      // project of any framework typechecked before this.
      expect(augmentation.startsWith("import '@taujs/server/config';")).toBe(true);
      expect(augmentation).toContain("declare module '@taujs/server/config'");
      // the import must precede the declaration, or it is still ambient
      expect(augmentation.indexOf("import '@taujs/server/config';")).toBeLessThan(augmentation.indexOf('declare module'));
    });

    it(`${framework}: declares esbuild, which build:server invokes directly`, () => {
      const { read } = generate(framework);
      const pkg = JSON.parse(read('package.json')) as { devDependencies: Record<string, string>; scripts: Record<string, string> };

      // The script shells out to the esbuild BINARY; it is not inherited from vite's own copy, so
      // every generated project failed `build:server` with "esbuild: command not found".
      expect(pkg.scripts['build:server']).toContain('esbuild ');
      expect(pkg.devDependencies.esbuild, 'build:server invokes esbuild but it is not declared').toBeTruthy();
    });
  }
});

describe('scaffolder baseline - the Vite builds pin NODE_ENV', () => {
  for (const framework of ['react', 'vue', 'solid'] as Framework[]) {
    it(`${framework}: build:client and build:entry-server force NODE_ENV=production`, () => {
      const { read } = generate(framework);
      const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;

      // Without this, bundle mode follows whatever NODE_ENV the caller happens to have. CI commonly
      // sets NODE_ENV=test, and vitest does - which baked React's DEV JSX runtime into the
      // PRODUCTION SSR bundle and crashed the production server with
      // "TypeError: jsxDEV is not a function". Measured: 40 `jsxDEV` references under
      // NODE_ENV=test, zero once pinned.
      expect(scripts['build:client']).toContain('NODE_ENV=production');
      expect(scripts['build:entry-server']).toContain('NODE_ENV=production');
      expect(scripts.build).toContain('NODE_ENV=production');
    });
  }
});
