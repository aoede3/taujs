// @vitest-environment node
// Upstream-sync guard (INDEX conventions addendum #1): @taujs/react is upstream for the
// shared utils. Streaming.ts must stay byte-identical to react's; Logger.ts must equal
// react's byte-for-byte plus only the appended createVueErrorHandler block. This test reads
// the sibling react sources at test time — the workspace layout is stable (if this ever
// proves brittle, escalate rather than weaken it).
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const vueStreaming = read('../Streaming.ts');
const reactStreaming = read('../../../../react/src/utils/Streaming.ts');
const vueLogger = read('../Logger.ts');
const reactLogger = read('../../../../react/src/utils/Logger.ts');
const vueHtml = read('../Html.ts');
const reactHtml = read('../../../../react/src/utils/Html.ts');

describe('utils upstream-sync drift guard', () => {
  it('Streaming.ts is byte-identical to @taujs/react/src/utils/Streaming.ts', () => {
    expect(vueStreaming).toBe(reactStreaming);
  });

  it('Html.ts is byte-identical to @taujs/react/src/utils/Html.ts (R2-02)', () => {
    expect(vueHtml).toBe(reactHtml);
  });

  it('Logger.ts equals react/src/utils/Logger.ts plus only the appended createVueErrorHandler block', () => {
    // react's Logger has no error-handler factory; vue appends exactly one.
    expect(reactLogger).not.toContain('createVueErrorHandler');
    // vue's Logger is a strict superset: react's file verbatim as a prefix...
    expect(vueLogger.startsWith(reactLogger)).toBe(true);
    // ...and the only divergence is the appended createVueErrorHandler block.
    const appended = vueLogger.slice(reactLogger.length);
    expect(appended).toContain('export function createVueErrorHandler');
    // the appended block declares nothing from the shared surface (only the factory).
    expect(appended).not.toContain('export function createUILogger');
  });
});
