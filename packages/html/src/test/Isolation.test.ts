import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIST_DIR = path.join(PACKAGE_ROOT, 'dist');

const collectJsFiles = (dir: string): string[] => {
  if (!existsSync(dir)) return [];

  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }

  return out;
};

describe('@taujs/html isolation', () => {
  it('no built JavaScript file under dist/ contains the string "@taujs/server" (declaration files legitimately carry type-only imports)', () => {
    const files = collectJsFiles(DIST_DIR);
    expect(files.length, 'dist/ is empty or missing - run `pnpm --filter @taujs/html build` before this test').toBeGreaterThan(0);

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      expect(content, `${path.relative(PACKAGE_ROOT, file)} must not reference @taujs/server at runtime`).not.toContain('@taujs/server');
    }
  });

  it("the package's package.json declares no dependencies", () => {
    const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };

    expect(pkg.dependencies === undefined || Object.keys(pkg.dependencies).length === 0).toBe(true);
  });

  it("src/ imports @taujs/server ONLY as `import type` (excluding this test file's own literal check)", () => {
    const SRC_DIR = path.join(PACKAGE_ROOT, 'src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        // `test/` is excluded: it is never part of the shipped `dist/`, and this very file needs to
        // name the import string it is checking for without being mistaken for an import site.
        if (entry.isDirectory() && entry.name !== 'test') walk(path.join(dir, entry.name));
        else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path.join(dir, entry.name));
      }
    };
    walk(SRC_DIR);

    expect(files.length).toBeGreaterThan(0);

    const IMPORT_SITE = /from ['"]@taujs\/server/;
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (const line of lines) {
        if (!IMPORT_SITE.test(line)) continue;
        expect(line, `${path.relative(PACKAGE_ROOT, file)}: "${line.trim()}" must be a type-only import`).toMatch(/^\s*import type /);
      }
    }
  });
});
