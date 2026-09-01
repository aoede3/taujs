// @vitest-environment node
//
// RFC 0015 Phase B V1: the packed proof that contract assets SHIP. `files` alone is a claim;
// this cell packs @taujs/server for real and asserts the published artefact carries
// contracts/index.json (parsing, schemaVersion 1, the render-strategies entry) and the document
// it names. Pack mechanics mirror PackedConfigComposition.test.ts.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url)); // packages/server/src/test -> packages/server

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('published contract assets', () => {
  it('the packed tarball ships contracts/index.json and the document it names', () => {
    const packDest = mkdtempSync(path.join(tmpdir(), 'taujs-contracts-pack-'));
    scratchDirs.push(packDest);

    execFileSync('npm', ['pack', '--pack-destination', packDest], { cwd: SERVER_DIR, stdio: 'pipe' });
    const tarball = readdirSync(packDest).find((f) => f.endsWith('.tgz'));
    expect(tarball).toBeDefined();

    const listing = execFileSync('tar', ['-tzf', path.join(packDest, tarball!)], { encoding: 'utf8' });
    expect(listing).toContain('package/contracts/index.json');
    expect(listing).toContain('package/contracts/render-strategies.md');

    execFileSync('tar', ['-xzf', path.join(packDest, tarball!), '-C', packDest, 'package/contracts/index.json'], { stdio: 'pipe' });
    const manifest = JSON.parse(readFileSync(path.join(packDest, 'package', 'contracts', 'index.json'), 'utf8'));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.owner).toBe('@taujs/server');
    expect(manifest.contracts.map((c: { id: string }) => c.id)).toContain('server:render-strategies');
    const entry = manifest.contracts.find((c: { id: string }) => c.id === 'server:render-strategies');
    expect(entry.doc).toBe('render-strategies.md');
  });
});
