/**
 * `@taujs/react/plugin` - the raw, portable React Vite plugin surface.
 *
 * `@vitejs/plugin-react` is a **peer dependency only**: intentionally NOT installed as a dependency to
 * avoid coupling τjs to a specific Vite toolchain or React-refresh implementation. Consumers using
 * `@taujs/react/plugin` install `@vitejs/plugin-react` themselves.
 *
 * `pluginReact()` is the raw React plugin pack, unchanged for single-framework/standalone use (real Vite
 * plugins, no `@taujs/server` needed). Its plugin objects carry a non-enumerable "unscoped compiler" tag
 * ONLY so the τjs host can detect a raw JSX compiler running chain-globally alongside managed ownership (a
 * hard error). For multi-framework τjs apps declare `renderer: reactRenderer(...)` (`@taujs/react/renderer`)
 * instead - the host computes each framework's scope and constructs the real plugin.
 */
import react from '@vitejs/plugin-react';

import { REACT_KEY, tagUnscopedCompiler, taujsReactPreambleFix } from './compiler/reactCompiler.js';

import type { PluginOption } from 'vite';

export function pluginReact(opts?: Parameters<typeof react>[0]): PluginOption {
  return tagUnscopedCompiler([react(opts), taujsReactPreambleFix()], REACT_KEY);
}
