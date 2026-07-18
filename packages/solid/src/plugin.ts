/**
 * `@taujs/solid/plugin` - the raw, portable Solid Vite plugin surface (ESC-1, RFC 0006).
 *
 * `vite-plugin-solid` is a **peer dependency only** (like `@vitejs/plugin-react` for `@taujs/react`):
 * consumers install it themselves. `pluginSolid()` is the raw Solid plugin, unchanged for
 * single-framework/standalone use (a real Vite plugin, no `@taujs/server` needed). Its plugin object
 * carries a non-enumerable "unscoped compiler" tag ONLY so the τjs host can detect a raw JSX compiler
 * running chain-globally alongside managed ownership (a hard error). For multi-framework τjs apps declare
 * `renderer: solidRenderer(...)` (`@taujs/solid/renderer`) instead.
 *
 * This package is the ESC-1 COMPILER surface only; the Solid renderer lands post-GO (S1).
 */
import solid from 'vite-plugin-solid';

import { SOLID_KEY, tagUnscopedCompiler } from './compiler/solidCompiler.js';

import type { Plugin, PluginOption } from 'vite';

export function pluginSolid(opts?: Parameters<typeof solid>[0]): PluginOption {
  return tagUnscopedCompiler(solid(opts) as Plugin, SOLID_KEY);
}
