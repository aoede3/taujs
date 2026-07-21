// Compile-time contract for @taujs/solid's client hydration surface (hydration-observability
// parity). Typechecked by `pnpm --filter @taujs/solid typecheck` (tsc); the `.test-d.ts` suffix is
// outside vitest's glob, so it never runs as a spec.
import type { JSX } from 'solid-js';

import type { HydrateAppOptions } from '../SSRHydration.js';

// 1. Exact key equality, both directions: the eight ruled members and nothing else. Adding or
//    removing an option flips this to `false` and breaks the assignment.
type ExpectedKeys = 'app' | 'renderId' | 'rootElementId' | 'logger' | 'enableDebug' | 'onStart' | 'onSuccess' | 'onHydrationError';
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _keysAreExact: Exact<keyof HydrateAppOptions, ExpectedKeys> = true;
void _keysAreExact;

const app = (_props: { location: string }): JSX.Element => null as unknown as JSX.Element;

// A fully-populated options object typechecks.
const _valid: HydrateAppOptions = {
  app,
  renderId: 'r',
  rootElementId: 'root',
  logger: { warn: () => {}, error: () => {} },
  enableDebug: true,
  onStart: () => {},
  onSuccess: () => {},
  onHydrationError: () => {},
};
void _valid;

// `onStart`/`onSuccess` take NO arguments in Solid (unlike Vue's App-instance form).
const _onStart: NonNullable<HydrateAppOptions['onStart']> = () => {};
const _onSuccess: NonNullable<HydrateAppOptions['onSuccess']> = () => {};
void _onStart;
void _onSuccess;

// 2. `dataKey` is NOT part of the Solid surface - τjs has one snapshot authority
//    (`window.__INITIAL_DATA__`).
// @ts-expect-error - dataKey is rejected
const _rejectDataKey: HydrateAppOptions = { app, dataKey: '__INITIAL_DATA__' };
void _rejectDataKey;

// 3. React-only / Vue-only options are rejected by analogy.
// @ts-expect-error - identifierPrefix is React-only
const _rejectIdentifierPrefix: HydrateAppOptions = { app, identifierPrefix: 'x' };
void _rejectIdentifierPrefix;

// @ts-expect-error - setupApp is Vue-only
const _rejectSetupApp: HydrateAppOptions = { app, setupApp: () => {} };
void _rejectSetupApp;
