// Type-level conformance test (V1-05). Proves @taujs/vue's `createRenderer(...)` output is
// assignable to @taujs/server's `RenderModule` contract WITH ZERO CASTS — the drift guard
// against F15. Enforced by `pnpm --filter @taujs/vue typecheck` (tsc); the repo has no
// type-test runner, and the `.test-d.ts` suffix is outside vitest's test glob so it never
// runs as a spec. NOTE: requires @taujs/server to be built first (types resolve to its dist).
import { h } from 'vue';

import type { RenderModule, RenderSSR, RenderStream, RenderStreamHandle } from '@taujs/server';

import { createRenderer } from '../SSRRender';

// The load-bearing assertion: the whole renderer module conforms, cast-free.
// The CONCRETE renderer output, deliberately un-annotated so tsc keeps its real inferred types.
// (Annotating this as `RenderModule` would erase them, and every return-shape assertion below would
// degrade into a tautology comparing the contract against itself - the width-subtyping blindness
// critical review #3 warns about.)
const _renderer = createRenderer({
  appComponent: () => h('div'),
  headContent: () => '',
});

// The load-bearing assertion: the whole renderer module conforms, cast-free.
const _module: RenderModule = _renderer;
void _module;

// And each half individually, for a sharper error if one diverges.
const _renderSSR: RenderSSR = _renderer.renderSSR;
const _renderStream: RenderStream = _renderer.renderStream;
void _renderSSR;
void _renderStream;

// R3-01 / critical review #3 (mirrored from react): assignability of the FUNCTION alone can hide a
// capability gap through width-subtyping, so pin the RETURN shape explicitly and in BOTH directions.
type VueStreamHandle = ReturnType<typeof _renderer.renderStream>;

// 1. What the renderer actually returns must satisfy the published handle contract.
const _handleSatisfiesContract: RenderStreamHandle = null as unknown as VueStreamHandle;
void _handleSatisfiesContract;

// 2. ...and every capability the contract REQUIRES must actually be present on it.
const _contractSatisfiedByHandle: VueStreamHandle = null as unknown as RenderStreamHandle;
void _contractSatisfiedByHandle;

// 3. `done` is the load-bearing member (R0-01: an unobserved rejection is the process-crash class).
const _done: Promise<void> = null as unknown as VueStreamHandle['done'];
void _done;

// ---------------------------------------------------------------------------------------------
// RFC 0004 (H6) - HARD GATE (ruling 7, vue twin of react's): a renderer instantiated with
// NON-DEFAULT generics must remain assignable to the host's broad contracts. Holds because the
// contract-facing signatures are BROAD with internal narrowing seams (the H2 regularisation
// model); re-narrowing any signature fails THESE lines, not production.
type PageData = { title: string; body: string };
type Ctx = { name: 'home' | 'article' };
type Head = { ogTitle: string; ogImage?: string };

const _typedRenderer = createRenderer<PageData, Ctx, Head>({
  appComponent: () => h('div'),
  headContent: ({ data, headData, meta, routeContext }) => `${data.title}${headData?.ogTitle ?? ''}${String(meta)}${routeContext?.name ?? ''}`,
});

const _typedModule: RenderModule = _typedRenderer;
const _typedSSR: RenderSSR = _typedRenderer.renderSSR;
const _typedStream: RenderStream = _typedRenderer.renderStream;
void _typedModule;
void _typedSSR;
void _typedStream;
