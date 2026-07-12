// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { createSSRStore } from '../SSRDataStore';

// R3-07 (S1) — the public `ready` promise must not be an unhandled-rejection crash class.
//
// `createSSRStore` is publicly exported; a user-constructed store whose loader rejects and whose
// `ready` is never rendered/awaited previously produced an `unhandledRejection`, which Node's
// default mode turns into a process-terminating `uncaughtException` (the R0-01 class, live in a
// shipped public API). As with R0-01, an in-process `process.on('unhandledRejection')` listener
// would itself change Node's default behaviour, so the crash is proven in a real CHILD process
// under DEFAULT flags, running the REAL `SSRDataStore.ts` transpiled at test time (the R0-01
// methodology — portable to the whole `engines.node >=20.11` range). `vue` resolves from this
// package's node_modules because the child inherits this package as cwd.
function buildChildScript(): string {
  const storeTs = fileURLToPath(new URL('../SSRDataStore.ts', import.meta.url));
  const transpiled = ts.transpileModule(readFileSync(storeTs, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  return [
    transpiled,
    // The store's own console.error diagnostic is expected noise; silence it so stdout is clean.
    `console.error = () => {};`,
    `createSSRStore(() => Promise.reject(new Error('R3-07 loader boom')));`,
    // The unhandled rejection (when the fix is absent) crashes the process well before this timer.
    `setTimeout(() => { console.log('SURVIVED'); process.exit(0); }, 150);`,
  ].join('\n');
}

describe('R3-07 public `ready` unhandled-rejection hardening', () => {
  it('a rejecting loader on a never-observed store does not crash the process (child process, default rejection mode)', () => {
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

  it('`await store.ready` still rejects with the loader error (the no-op handler does not consume the rejection)', async () => {
    const consoleError = console.error;
    console.error = () => {};
    try {
      const store = createSSRStore<{ v: string }>(() => Promise.reject(new Error('R3-07 loader boom')));

      await expect(store.ready).rejects.toThrow('R3-07 loader boom');
      expect(store.status.value).toBe('error');
    } finally {
      console.error = consoleError;
    }
  });

  it('`ready` stays rejected after a recovering setData (settle-once pinned)', async () => {
    const consoleError = console.error;
    console.error = () => {};
    try {
      const store = createSSRStore<{ v: string }>(() => Promise.reject(new Error('R3-07 loader boom')));
      await expect(store.ready).rejects.toThrow('R3-07 loader boom');

      store.setData({ v: 'recovered' });

      expect(store.status.value).toBe('success');
      expect(store.getSnapshot()).toEqual({ v: 'recovered' });
      // Promises settle once: the recovering setData cannot re-settle `ready`.
      await expect(store.ready).rejects.toThrow('R3-07 loader boom');
    } finally {
      console.error = consoleError;
    }
  });
});
