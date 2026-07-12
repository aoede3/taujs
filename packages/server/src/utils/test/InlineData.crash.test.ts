// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, it, expect } from 'vitest';

// R0-04 — the second process-crash class (after R0-01's unobserved `done` rejection).
//
// The streaming `finish` listener in HandleRender runs on a stream tick, OUTSIDE the request
// try/catch (see the `processTicksAndRejections` frame in the failure below), so an uncaught
// throw there becomes an `uncaughtException` → process exit. This test proves BOTH halves:
//   (a) an UNGUARDED `JSON.stringify(circular)` in an async 'finish' listener genuinely crashes
//       the process under Node's DEFAULT flags, and
//   (b) the real `serializeInlineData` boundary never throws, so the identical listener survives.
//
// METHODOLOGY (maintainer decision, 2026-07-11): unlike R0-01 — which transpiled the
// self-contained `Streaming.ts` and drove it directly — the real crash lives inside
// `handleRender`, which is NOT exported and has many extensionless relative imports Node's
// native-TS runner cannot resolve, so it cannot be executed in a child. We therefore prove the
// crash CLASS generically here (transpiling the self-contained `InlineData.ts` and using the REAL
// `serializeInlineData` as the fix primitive), and verify the actual `handleRender` finish-listener
// wiring with an in-process integration test (`HandleRender.test.ts`: streaming route, circular
// data, real async finish → deterministic termination, no data script, no crash). The same split
// applies to any future crash-class test for a multi-import server module.

function buildChild(bodyExpr: string): string {
  const inlineDataTs = fileURLToPath(new URL('../InlineData.ts', import.meta.url));
  const transpiled = ts.transpileModule(readFileSync(inlineDataTs, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  return [
    `import { PassThrough } from 'node:stream';`,
    transpiled,
    `const circular = {}; circular.self = circular;`,
    `const w = new PassThrough();`,
    // 'finish' fires ASYNCHRONOUSLY (real stream tick), outside any try/catch — the R0-04 shape.
    `w.on('finish', () => { ${bodyExpr} });`,
    `w.end();`,
    `setTimeout(() => { console.log('SURVIVED'); process.exit(0); }, 150);`,
  ].join('\n');
}

function runChild(script: string): { status: number; stdout: string } {
  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  } catch (err) {
    status = (err as { status?: number | null }).status ?? 1;
    stdout = String((err as { stdout?: unknown }).stdout ?? '');
  }
  return { status, stdout };
}

describe('R0-04 crash class — serialization in an async finish listener', () => {
  it('an UNGUARDED JSON.stringify(circular) crashes the process (proves the class)', () => {
    const { status, stdout } = runChild(buildChild('JSON.stringify(circular);'));

    expect(status).not.toBe(0);
    expect(stdout).not.toContain('SURVIVED');
  });

  it('the real serializeInlineData boundary never throws — the identical listener survives', () => {
    const { status, stdout } = runChild(buildChild('serializeInlineData(circular);'));

    expect(status).toBe(0);
    expect(stdout).toContain('SURVIVED');
  });
});
