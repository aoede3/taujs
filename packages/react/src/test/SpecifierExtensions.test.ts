// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// R3-05 (Q6) — every relative import/export specifier in emitted source must carry an explicit
// `.js` extension. tsup builds with `bundle: false` and emits specifiers AS-IS; an extensionless
// relative specifier ships a dist that fails Node ESM with ERR_MODULE_NOT_FOUND. Test files are
// excluded (they run under vitest's resolver and are never emitted), as are `.d.ts` files.
const SRC = fileURLToPath(new URL('..', import.meta.url));

const RELATIVE_SPECIFIER = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.\.?\/[^'"]+)['"]/g;

function emittedSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'test' ? [] : emittedSourceFiles(full);
    if (!/\.(ts|tsx)$/.test(entry.name) || entry.name.endsWith('.d.ts')) return [];
    return [full];
  });
}

describe('R3-05 relative specifier extensions (dist integrity guard)', () => {
  it('every relative specifier in emitted source carries an explicit extension', () => {
    const offenders: string[] = [];

    for (const file of emittedSourceFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(RELATIVE_SPECIFIER)) {
        const spec = match[1]!;
        if (!/\.(js|json|css)$/.test(spec)) offenders.push(`${path.relative(SRC, file)} -> '${spec}'`);
      }
    }

    expect(offenders, `extensionless relative specifiers break the bundle:false dist (Node ESM ERR_MODULE_NOT_FOUND):\n${offenders.join('\n')}`).toEqual([]);
  });
});
