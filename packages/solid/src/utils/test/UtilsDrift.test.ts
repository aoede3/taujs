// @vitest-environment node
// Upstream-sync guard. @taujs/react is upstream for the shared utils, and @taujs/vue established
// this pattern (`vue/src/utils/test/UtilsDrift.test.ts`).
//
// SCOPE, per the slice-3 ruling: ONLY genuinely framework-neutral HTML utilities are drift-copied.
// `Html.ts` qualifies - `escapeHtml` is HTML escaping and nothing else.
//
// `Streaming.ts` is deliberately NOT drift-copied here, unlike @taujs/vue. React's controller
// encodes React's completion/error/socket semantics, and Solid's differ in ruled ways: seroval
// serialisation failure is FATAL (design 2, R3), a post-shell watchdog fatality must never call
// `end()`, `onAllReady` is two-latch, and Solid never emits `onRenderError` at all. Byte-identity
// with React would import the wrong semantics by analogy - the exact thing the ruling forbids.
// `Logger.ts` is likewise not drift-copied: the frozen public API (design 1.5) names
// `ServerLogger`, where React's is `ServerLogs`, so Solid's follows the DESIGN, not React.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

describe('utils upstream-sync drift guard', () => {
  it('Html.ts is byte-identical to @taujs/react/src/utils/Html.ts', () => {
    expect(read('../Html.ts')).toBe(read('../../../../react/src/utils/Html.ts'));
  });

  it('Streaming.ts is deliberately NOT a copy of react\'s (Solid follows the ruled matrix)', () => {
    // A regression guard on the RULING, not on bytes: if someone later "syncs" this file with
    // react's, the Solid-specific fatality semantics disappear silently. These markers are the
    // ruled divergences.
    const solidStreaming = read('../Streaming.ts');
    const reactStreaming = read('../../../../react/src/utils/Streaming.ts');

    expect(solidStreaming).not.toBe(reactStreaming);
    // Case-insensitive: the marker is prose, and pinning its exact casing makes the guard brittle
    // for no benefit.
    expect(solidStreaming).toMatch(/serialisation failure/i); // R3 fatal channel, absent in react
    expect(reactStreaming).not.toMatch(/serialisation failure/i);
    expect(solidStreaming).toMatch(/detach/i); // M1 release on every terminal, absent in react
  });
});
