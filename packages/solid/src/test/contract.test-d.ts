// Type-level conformance test - design 7.5's REQUIRED acceptance leg.
//
// This proves @taujs/solid's `createRenderer(...)` output is assignable to @taujs/server's
// `RenderModule` contract WITH ZERO CASTS at the assignment seam. It is the gate the V6-checks
// frozen-sketch check explicitly does NOT substitute for: that check transcribed the design's
// declared type surface and proved the SKETCH was not divergent, using a `declare function`. This
// one uses the IMPLEMENTATION's real inferred output, so a divergence between what the design says
// and what the code actually returns fails here and nowhere else.
//
// Enforced by `pnpm --filter @taujs/solid typecheck` (tsc). The repo has no type-test runner, and
// the `.test-d.ts` suffix is outside vitest's glob, so this never runs as a spec.
// NOTE: requires @taujs/server to be built first (types resolve to its dist).
import type { JSX } from 'solid-js';

import type { RenderModule, RenderSSR, RenderStream, RenderStreamHandle } from '@taujs/server';

import { createRenderer } from '../SSRRender.js';

// A type-level stand-in for an app component. This module carries no JSX transform of its own, and
// the component's BODY is irrelevant here - only its signature participates in the assertions.
const appComponent = (): JSX.Element => null as unknown as JSX.Element;

// The CONCRETE renderer output, deliberately UN-ANNOTATED so tsc keeps its real inferred types.
// Annotating this as `RenderModule` would erase them and degrade every assertion below into a
// tautology comparing the contract against itself.
const _renderer = createRenderer({
  appComponent,
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

// Assignability of the FUNCTION alone can hide a capability gap through width-subtyping, so pin
// the RETURN shape explicitly and in BOTH directions (design 1.5, requirement 3).
//
// HONEST LIMIT, recorded so this is not over-read: `renderStream` carries an explicit
// `: RenderStreamHandle` return annotation, so `ReturnType<...>` resolves to the PACKAGE'S alias
// rather than a structurally-inferred shape. What these two directions therefore prove is that the
// package's alias and the HOST's contract agree - which is real (widening `done` to
// `Promise<unknown>` fails here, verified). A returned object that is structurally short of the
// alias is caught at the RETURN SITE instead, by the annotation itself (dropping `abort()` yields
// TS2741 there, also verified). Between the two mechanisms nothing gets through; they simply fail
// in different places, and it is worth knowing which.
type SolidStreamHandle = ReturnType<typeof _renderer.renderStream>;

// 1. What the renderer actually returns must satisfy the published handle contract.
const _handleSatisfiesContract: RenderStreamHandle = null as unknown as SolidStreamHandle;
void _handleSatisfiesContract;

// 2. ...and every capability the contract REQUIRES must actually be present on it.
const _contractSatisfiedByHandle: SolidStreamHandle = null as unknown as RenderStreamHandle;
void _contractSatisfiedByHandle;

// 3. `done` is the load-bearing member: an unobserved rejection is the process-crash class, and a
//    widened `done` would let a renderer resolve something other than void on a fatal.
const _done: Promise<void> = null as unknown as SolidStreamHandle['done'];
void _done;

// ---------------------------------------------------------------------------------------------
// NON-DEFAULT GENERICS (design 1.5, requirement 2). A renderer instantiated with narrow `T/R/H`
// must remain assignable to the host's BROAD contracts. This holds because the contract-facing
// signatures are broad with internal narrowing seams; re-narrowing any signature fails THESE
// lines rather than production.
// ---------------------------------------------------------------------------------------------
type PageData = { title: string; body: string };
type Ctx = { name: 'home' | 'article' };
type Head = { ogTitle: string; ogImage?: string };

const _typedRenderer = createRenderer<PageData, Ctx, Head>({
  appComponent,
  headContent: ({ data, headData, meta, routeContext }) => `${data.title}${headData?.ogTitle ?? ''}${String(meta)}${routeContext?.name ?? ''}`,
});

const _typedModule: RenderModule = _typedRenderer;
const _typedSSR: RenderSSR = _typedRenderer.renderSSR;
const _typedStream: RenderStream = _typedRenderer.renderStream;
void _typedModule;
void _typedSSR;
void _typedStream;

// The narrow instantiation's handle must satisfy the contract too - a generic parameter must not
// leak into the returned lifecycle handle.
const _typedDone: Promise<void> = null as unknown as ReturnType<typeof _typedRenderer.renderStream>['done'];
void _typedDone;
