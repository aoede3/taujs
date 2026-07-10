// Type-level conformance test (V1-05). Proves @taujs/vue's `createRenderer(...)` output is
// assignable to @taujs/server's `RenderModule` contract WITH ZERO CASTS — the drift guard
// against F15. Enforced by `pnpm --filter @taujs/vue typecheck` (tsc); the repo has no
// type-test runner, and the `.test-d.ts` suffix is outside vitest's test glob so it never
// runs as a spec. NOTE: requires @taujs/server to be built first (types resolve to its dist).
import { h } from 'vue';

import type { RenderModule, RenderSSR, RenderStream } from '@taujs/server';

import { createRenderer } from '../SSRRender';

// The load-bearing assertion: the whole renderer module conforms, cast-free.
const _module: RenderModule = createRenderer({
  appComponent: () => h('div'),
  headContent: () => '',
});
void _module;

// And each half individually, for a sharper error if one diverges.
const _renderSSR: RenderSSR = _module.renderSSR;
const _renderStream: RenderStream = _module.renderStream;
void _renderSSR;
void _renderStream;
