// @vitest-environment node
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach } from 'vitest';

import { emptyOutDirPreserving, preservedOutDirEntries } from '../OutDir';

describe('preservedOutDirEntries', () => {
  const outDir = path.resolve('/p/dist/client');

  it('keeps the first segment of every declared descendant, and nothing else', () => {
    expect(
      preservedOutDirEntries(outDir, [
        outDir,
        path.resolve('/p/dist/client/admin'),
        path.resolve('/p/dist/client/deep/nested'),
        path.resolve('/p/dist/ssr/admin'),
        path.resolve('/p/dist/client-other'),
      ]).sort(),
    ).toEqual(['admin', 'deep']);
  });

  it('is not fooled by a sibling whose path merely shares the prefix string', () => {
    expect(preservedOutDirEntries(outDir, [path.resolve('/p/dist/clientele')])).toEqual([]);
  });

  it('returns nothing when no declared app sits inside the directory', () => {
    expect(preservedOutDirEntries(path.resolve('/p/dist/client/child'), [path.resolve('/p/dist/client')])).toEqual([]);
  });

  it('de-duplicates two descendants sharing a first segment', () => {
    expect(preservedOutDirEntries(outDir, [path.resolve('/p/dist/client/a/one'), path.resolve('/p/dist/client/a/two')])).toEqual(['a']);
  });
});

describe('emptyOutDirPreserving', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'taujs-outdir-'));
  });

  it('removes everything except the preserved entries and .git', async () => {
    await mkdir(path.join(dir, 'keep', 'nested'), { recursive: true });
    await mkdir(path.join(dir, 'drop-dir'), { recursive: true });
    await mkdir(path.join(dir, '.git'), { recursive: true });
    await writeFile(path.join(dir, 'keep', 'nested', 'f.js'), '//', 'utf8');
    await writeFile(path.join(dir, 'drop-file.js'), '//', 'utf8');

    await emptyOutDirPreserving(dir, ['keep']);

    expect((await readdir(dir)).sort()).toEqual(['.git', 'keep']);
    expect(existsSync(path.join(dir, 'keep', 'nested', 'f.js'))).toBe(true);
  });

  it('treats a directory that does not exist yet as the ordinary first-build case', async () => {
    await expect(emptyOutDirPreserving(path.join(dir, 'never-built'), [])).resolves.toBeUndefined();
  });

  it('PROPAGATES any failure that is not ENOENT, rather than silently skipping the cleanup', async () => {
    // A path that is a FILE gives ENOTDIR - deterministic, and unlike a permission case it does not
    // depend on the test user. Swallowing this would leave stale output behind while Vite has
    // already been told `emptyOutDir: false`.
    const notADir = path.join(dir, 'a-file');
    await writeFile(notADir, '//', 'utf8');

    await expect(emptyOutDirPreserving(notADir, [])).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});
