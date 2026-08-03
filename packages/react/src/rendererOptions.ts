/**
 * Compiler-free option surface + validation for `reactRenderer()` - the ONE definition shared by the
 * synchronous factory (construction-time errors) and the lazy compiler builder (which receives the same
 * validated shape), so the two sides cannot drift.
 *
 * This module must stay free of compiler VALUE imports: it loads at declaration time in production
 * processes, and the recorder gate asserts the production graph never resolves the compiler toolchain.
 * The `@vitejs/plugin-react` reference below is type-only and erases at compile time.
 */
import type react from '@vitejs/plugin-react';

type ReactOptions = NonNullable<Parameters<typeof react>[0]>;

/** Options for `reactRenderer()`: a required tsconfig `project` plus React options; the ownership
 * filters (`include`/`exclude`) are RESERVED - the host computes them from the project. */
export type ReactRendererOptions = { project: string } & Omit<ReactOptions, 'include' | 'exclude'>;

/** Synchronous validation; returns the options unchanged for the lazy builder to consume. */
export function validateReactRendererOptions(opts: ReactRendererOptions): ReactRendererOptions {
  if (!opts?.project) throw new Error('[taujs] reactRenderer requires a `project` tsconfig path.');
  if ('include' in opts || 'exclude' in opts) {
    throw new Error('[taujs] reactRenderer does not accept `include`/`exclude` - ownership is computed from the tsconfig `project`.');
  }
  return opts;
}
