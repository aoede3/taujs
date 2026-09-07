// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The package's REAL export - the same entry the shipped CLI calls to plan its output - rather than
// the individual `generate*()` template functions. Mirrors cli-solid.test.ts cell for cell.
import { planFiles, type Framework, type ProjectConfig } from '../index.js';

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

describe('create-taujs CLI - the shipped binary knows about HTML', () => {
  it('the built CLI exists and accepts --framework=html without a validation error', () => {
    expect(existsSync(CLI), `CLI dist missing at ${CLI} - run \`pnpm build\` first`).toBe(true);

    const dir = mkdtempSync(path.join(tmpdir(), 'taujs-cli-'));
    try {
      // With no TTY the CLI reaches the package-manager prompt and exits without writing, so this
      // asserts on the VALIDATION output: a known framework produces no rejection message.
      const output = execFileSync(process.execPath, [CLI, 'demo-app', '--framework=html'], {
        cwd: dir,
        stdio: 'pipe',
        encoding: 'utf8',
      });

      expect(output).not.toContain('Invalid framework');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the built CLI REJECTS an unknown framework, and names html as valid', () => {
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
      expect(output).toContain('html'); // the valid list now includes it
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('create-taujs - HTML generation (through the package export)', () => {
  it('plans a complete project', () => {
    const { has } = generate('html');

    expect(has('package.json')).toBe(true);
    expect(has('taujs.config.ts')).toBe(true);
  });

  it('declares renderer: htmlRenderer() and NO active plugins: entry', () => {
    const { read } = generate('html');
    const config = read('taujs.config.ts');

    expect(config).toContain("import { htmlRenderer } from '@taujs/html/renderer';");
    expect(config).toContain('renderer: htmlRenderer(),');
    // The shared template carries a COMMENTED example vite.plugins block for every framework - the
    // claim here is no ACTIVE plugins: key, so comment-prefixed lines are excluded from the check.
    const activeLines = config.split('\n').filter((line) => !line.trim().startsWith('//'));
    expect(activeLines.some((line) => line.includes('plugins:'))).toBe(false);
  });

  it('package.json declares no Vite plugin and no framework runtime dependency, and externals @taujs/html', () => {
    const { read } = generate('html');
    const pkg = JSON.parse(read('package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };

    const devDepKeys = Object.keys(pkg.devDependencies);
    expect(devDepKeys.some((dep) => dep.startsWith('@vitejs/') || dep.startsWith('vite-plugin-'))).toBe(false);

    expect(pkg.dependencies.react).toBeUndefined();
    expect(pkg.dependencies.vue).toBeUndefined();
    expect(pkg.dependencies['solid-js']).toBeUndefined();
    expect(pkg.dependencies['@taujs/html']).toBeTruthy();

    expect(pkg.scripts['build:server']).toContain('--external:@taujs/html');
  });

  it('tsconfig.json has no jsx key and no jsxImportSource', () => {
    const { read } = generate('html');
    const tsconfig = JSON.parse(read('tsconfig.json')) as { compilerOptions: Record<string, unknown> };

    expect(tsconfig.compilerOptions).not.toHaveProperty('jsx');
    expect(tsconfig.compilerOptions).not.toHaveProperty('jsxImportSource');
  });

  it('entry-server.ts imports createRenderer from @taujs/html and passes renderPage', () => {
    const { read } = generate('html');
    const entryServer = read('src/client/entry-server.ts');

    expect(entryServer).toContain("import { createRenderer } from '@taujs/html';");
    expect(entryServer).toContain("import { renderPage } from './page';");
    expect(entryServer).toContain('render: renderPage,');
  });

  it('entry-client.ts imports onDataReady from @taujs/html/client, never hydrateApp, and enhances the server-rendered HTML in place', () => {
    const { read } = generate('html');
    const entryClient = read('src/client/entry-client.ts');

    expect(entryClient).toContain("import { onDataReady } from '@taujs/html/client';");
    expect(entryClient).not.toContain('hydrateApp');

    // The enhancement itself: four separate assertions on the generated text, not one substring
    // match, so a change that keeps SOME of the behaviour but drops the rest is still caught.
    expect(entryClient).toContain("querySelector('.card-meta')");
    expect(entryClient).toContain('.textContent =');
    expect(entryClient).toContain('new Date(data.timestamp).toLocaleString()');
    expect(entryClient).toContain("'data-enhanced', 'true'");
  });

  it("page.ts escapes every interpolation - no \\${ in its template literals is followed by anything other than escapeHtml(", () => {
    const { read } = generate('html');
    const page = read('src/client/page.ts');

    // Only the two RETURNED template literals (headContent/appHtml) are in scope for this rule -
    // isolate them from the rest of the file (the escapeHtml function body itself contains no
    // `${` at all, so scanning the whole file is equivalent and simpler).
    const interpolations = [...page.matchAll(/\$\{([^}]*)/g)];
    expect(interpolations.length).toBeGreaterThan(0);
    for (const [, expr] of interpolations) {
      expect(expr!.trimStart(), `un-escaped interpolation: \${${expr}`).toMatch(/^escapeHtml\(/);
    }
  });

  it('README links MDN, never react.dev, and its tree lists page.ts', () => {
    const { read } = generate('html');
    const readme = read('README.md');

    expect(readme).toContain('[HTML Documentation](https://developer.mozilla.org/docs/Web/HTML)');
    expect(readme).not.toContain('react.dev');
    expect(readme).toContain('page.ts');
  });
});
