// Type-level conformance test (R3-01, mirroring @taujs/vue's V1-05 template). Proves
// @taujs/react's `createRenderer(...)` output is assignable to @taujs/server's `RenderModule`
// contract WITH ZERO CASTS — the drift guard against a renderer silently diverging from the host
// contract. Enforced by `pnpm --filter @taujs/react typecheck` (tsc); the repo has no type-test
// runner, and the `.test-d.ts` suffix is outside vitest's test glob so it never runs as a spec.
// NOTE: requires @taujs/server to be built first (types resolve to its dist).
import { createElement } from 'react';

import type { RenderModule, RenderSSR, RenderStream, RenderStreamHandle } from '@taujs/server';

import { createRenderer } from '../SSRRender';

// The CONCRETE renderer output, deliberately un-annotated so tsc keeps its real inferred types.
// (Annotating this as `RenderModule` would erase them, and every return-shape assertion below would
// degrade into a tautology comparing the contract against itself - the exact width-subtyping
// blindness critical review #3 warns about.)
const _renderer = createRenderer({
  appComponent: () => createElement('div'),
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

// R3-01 / critical review #3: assignability of the FUNCTION alone can hide a capability gap through
// width-subtyping, so pin the RETURN shape explicitly and in BOTH directions - against the ACTUAL
// renderer return type, not the contract alias.
type ReactStreamHandle = ReturnType<typeof _renderer.renderStream>;

// 1. What the renderer actually returns must satisfy the published handle contract (catches a
//    missing/mistyped `done` — the crash-class channel R0-01 shipped).
const _handleSatisfiesContract: RenderStreamHandle = null as unknown as ReactStreamHandle;
void _handleSatisfiesContract;

// 2. ...and every capability the contract REQUIRES must actually be present on it (catches a handle
//    that only structurally passes because the contract is narrower than the capability it needs).
const _contractSatisfiedByHandle: ReactStreamHandle = null as unknown as RenderStreamHandle;
void _contractSatisfiedByHandle;

// 3. `done` is the load-bearing member (R0-01: an unobserved rejection is the process-crash class).
//    Pin it on the ACTUAL return type, not on the contract alias.
const _done: Promise<void> = null as unknown as ReactStreamHandle['done'];
void _done;
