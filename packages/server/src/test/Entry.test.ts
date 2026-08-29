// @vitest-environment node
//
// Entry.ts has no test file of its own; this is its home.
//
// The default `exists` must reject a directory that happens to share an entry candidate's name -
// existsSync (the old default) is true for directories too, so a stale `entry-client.ts/` folder
// would resolve as the entry and fail later at bundling or on the first dev request. These cells
// use the REAL filesystem and the default parameter (no `exists` override, no fs mocks) so they
// exercise that default directly.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { resolveEntryFile } from '../utils/Entry';
import { ENTRY_EXTENSIONS } from '../constants';

describe('resolveEntryFile - real filesystem, directory vs file', () => {
  let parentDir: string;

  beforeAll(() => {
    parentDir = mkdtempSync(path.join(tmpdir(), 'taujs-server-entry-'));
  });

  afterAll(() => {
    rmSync(parentDir, { recursive: true, force: true });
  });

  it('skips a same-named directory and resolves to the real file at the next probed extension', () => {
    const clientRoot = path.join(parentDir, 'directory-then-file');
    mkdirSync(path.join(clientRoot, `entry-client${ENTRY_EXTENSIONS[0]}`), { recursive: true });
    writeFileSync(path.join(clientRoot, `entry-client${ENTRY_EXTENSIONS[1]}`), '');

    const result = resolveEntryFile(clientRoot, 'entry-client');
    expect(result).toBe(`entry-client${ENTRY_EXTENSIONS[1]}`);
  });

  it('throws the not-found error when every candidate is a directory, not a file', () => {
    const clientRoot = path.join(parentDir, 'directory-only');
    mkdirSync(path.join(clientRoot, `entry-client${ENTRY_EXTENSIONS[0]}`), { recursive: true });

    expect(() => resolveEntryFile(clientRoot, 'entry-client')).toThrowError(
      new Error(`Entry file "entry-client" not found in ${clientRoot}. Tried: ${ENTRY_EXTENSIONS.map((e) => 'entry-client' + e).join(', ')}`),
    );
  });

  it('resolves to a real file when nothing shadows it (control)', () => {
    const clientRoot = path.join(parentDir, 'file-only');
    mkdirSync(clientRoot, { recursive: true });
    writeFileSync(path.join(clientRoot, `entry-client${ENTRY_EXTENSIONS[0]}`), '');

    const result = resolveEntryFile(clientRoot, 'entry-client');
    expect(result).toBe(`entry-client${ENTRY_EXTENSIONS[0]}`);
  });
});
