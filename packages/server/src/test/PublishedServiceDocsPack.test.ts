// @vitest-environment node
//
// Public service documentation is useful only when it survives the declaration bundle and npm
// package boundary. This cell packs the built package, extracts its declarations and checks the
// small evidence-earned service slice rather than counting comments in source.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const newestSourceMtime = (directory: string): number => {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'test' || entry.name === 'node_modules') continue;
    const candidate = path.join(directory, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestSourceMtime(candidate) : statSync(candidate).mtimeMs);
  }
  return newest;
};

describe('published service documentation', () => {
  it('ships the critical service and AppError comments in the packed declarations', () => {
    const builtConfigDts = path.join(SERVER_DIR, 'dist', 'Config.d.ts');
    if (!existsSync(builtConfigDts) || statSync(builtConfigDts).mtimeMs < newestSourceMtime(path.join(SERVER_DIR, 'src'))) {
      throw new Error('@taujs/server dist is absent or older than src - run `pnpm --filter @taujs/server build` before this test packs it');
    }

    const packDest = mkdtempSync(path.join(tmpdir(), 'taujs-service-docs-pack-'));
    scratchDirs.push(packDest);
    execFileSync('npm', ['pack', '--pack-destination', packDest], { cwd: SERVER_DIR, stdio: 'pipe' });
    const tarball = readdirSync(packDest).find((file) => file.endsWith('.tgz'));
    if (!tarball) throw new Error('npm pack produced no tarball');

    execFileSync('tar', ['-xzf', path.join(packDest, tarball), '-C', packDest, 'package/dist'], { stdio: 'pipe' });
    const declarations = readdirSync(path.join(packDest, 'package', 'dist'))
      .filter((file) => file.endsWith('.d.ts'))
      .map((file) => readFileSync(path.join(packDest, 'package', 'dist', file), 'utf8'))
      .join('\n');

    for (const text of [
      'Base request context passed to service methods.',
      'Returns `signal` unchanged when `ms` is falsy',
      'later parent aborts with their reason or aborts after `ms`',
      'An already-aborted',
      'consumers must observe the signal to cancel their work.',
      'Defines and freezes a service method map.',
      'Returns a new frozen registry whose service objects are shallow-frozen.',
      'Stable application-error categories.',
      'An error with a stable {@link ErrorKind}, HTTP status and client-safe message.',
      'Creates an error, optionally overriding its status or safe message',
      'Creates a `domain` error with HTTP status 404.',
      'Creates an `auth` error with HTTP status 403.',
      'Creates a `validation` error with HTTP status 400.',
      'Creates a `validation` error with HTTP status 422.',
      'Creates a `timeout` error with HTTP status 504.',
      'Creates a `canceled` error with HTTP status 499.',
      'Creates an `infra` error with HTTP status 500 and retains the optional cause.',
      'Creates an `upstream` error with HTTP status 502 and retains the optional cause.',
      'Creates an `infra` error with HTTP status 503 and retains the optional cause.',
      'Returns an existing `AppError`, or wraps another value as an `infra` error',
    ]) {
      expect(declarations, `missing packed declaration documentation: ${text}`).toContain(text);
    }
  });
});
