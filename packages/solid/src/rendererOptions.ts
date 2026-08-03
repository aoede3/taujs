/**
 * Compiler-free option surface + validation for `solidRenderer()` - the ONE definition shared by the
 * synchronous factory (construction-time errors) and the lazy compiler builder (which receives the same
 * validated shape), so the two sides cannot drift.
 *
 * This module must stay free of compiler imports: it loads at declaration time in production processes,
 * and the recorder gate asserts the production graph never resolves the compiler toolchain.
 */

/**
 * The renderer's ENTIRE option surface (design 1.5, frozen): a single required tsconfig `project` that
 * defines the app's ownership boundary. Ownership `include`/`exclude` are RESERVED - the host computes
 * them from the project - and no transform-mode option is offered.
 */
export type SolidRendererOptions = { project: string };

/** Synchronous validation; returns the options unchanged for the lazy builder to consume. */
export function validateSolidRendererOptions(opts: SolidRendererOptions): SolidRendererOptions {
  const { project, ...rest } = opts ?? ({} as SolidRendererOptions);
  if (!project) throw new Error('[taujs] solidRenderer requires a `project` tsconfig path.');
  // `{ project }` is the entire surface. Anything else - including the previously-tolerated
  // `include`/`exclude` and any vite-plugin-solid option - is rejected rather than silently dropped,
  // so a caller is told their intent is not supported instead of it vanishing.
  const unsupported = Object.keys(rest);
  if (unsupported.length > 0) {
    throw new Error(
      `[taujs] solidRenderer accepts only \`project\` (received: ${unsupported.join(', ')}). Ownership is computed from the tsconfig project, and the transform mode is fixed. Use pluginSolid() from '@taujs/solid/plugin' for raw Vite options.`,
    );
  }
  return opts;
}
