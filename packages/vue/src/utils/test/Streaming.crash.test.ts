// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, it, expect } from 'vitest';

import { createStreamController } from '../Streaming';

// R0-01 — crash-safe `done` (vue drift-copy of react's crash regression; `utils/Streaming.ts`
// is byte-identical across both packages — see UtilsDrift.test.ts).
//
// Every in-process streaming test AWAITS `done`, which is exactly why the unobserved-rejection
// crash was invisible to the suite. An in-process `process.on('unhandledRejection')` listener
// would itself change Node's default behaviour, so the crash is proven in a real CHILD process
// under DEFAULT flags — Node's default (crash) mode applies.
//
// The child runs the REAL `Streaming.ts`, transpiled to plain JS at test time (via the
// TypeScript compiler, a devDependency) and executed with `node --input-type=module -e`. This
// keeps the guard portable to EVERY supported Node (`engines.node` is `>=20.11`, `.nvmrc` is
// `22.17.0`) instead of relying on native `.ts` execution (Node >= 22.18 only) — while still
// exercising the actual source, so reverting the `settle.done.catch(...)` fix fails this test.
function buildChildScript(): string {
  const streamingTs = fileURLToPath(new URL('../Streaming.ts', import.meta.url));
  const transpiled = ts.transpileModule(readFileSync(streamingTs, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  return [
    `import { PassThrough } from 'node:stream';`,
    transpiled,
    `const noop = () => {};`,
    `const controller = createStreamController(new PassThrough(), { log: noop, warn: noop, error: noop });`,
    // Stands in for any fatal stream error (a non-benign writable error, `onShellError`, or the
    // first-content watchdog) — all route through `fatalAbort` -> `settle.reject`. `done` is
    // never observed here, exactly as the server call site did before R0-01.
    `controller.fatalAbort(new Error('R0-01 fatal-boom'));`,
    `setTimeout(() => { console.log('SURVIVED'); process.exit(0); }, 150);`,
  ].join('\n');
}

describe('R0-01 crash-safe done', () => {
  it('does not crash the process when a fatal abort rejects an unobserved `done` (child process, default rejection mode)', () => {
    let status = 0;
    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, ['--input-type=module', '-e', buildChildScript()], { encoding: 'utf8' });
    } catch (err) {
      status = (err as { status?: number | null }).status ?? 1;
      stdout = String((err as { stdout?: unknown }).stdout ?? '');
    }

    expect(status).toBe(0);
    expect(stdout).toContain('SURVIVED');
  });

  it('still rejects `done` for consumers who await it', async () => {
    const noop = () => {};
    const controller = createStreamController(new PassThrough(), { log: noop, warn: noop, error: noop });

    controller.fatalAbort(new Error('R0-01 fatal-boom'));

    await expect(controller.done).rejects.toThrow('R0-01 fatal-boom');
  });
});
