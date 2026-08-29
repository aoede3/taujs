// A LOCAL stale-build guard, the same convention as
// `fixtures/renderer-composition/test/support/built-server.ts`: this fixture's own `typecheck`
// (`tsc`, covering `src/recipe.ts`) resolves `@taujs/server` through the workspace link straight
// to `dist/*.d.ts`, so a STALE `dist` would let a broken change to the public surface pass
// silently. `pnpm run check`/`pnpm -r build` before `pnpm -r test` is the authoritative guarantee;
// this only turns a direct `pnpm --filter rfc-0014-recipe test` into an actionable failure instead
// of a quietly stale pass.
import { describe, it } from 'vitest';

import { assertWorkspacePackagesBuilt } from '../../test-support/BuiltPackages';

describe('rfc-0014-recipe fixture', () => {
  it('requires a fresh @taujs/server build', () => {
    assertWorkspacePackagesBuilt(['server']);
  });
});
