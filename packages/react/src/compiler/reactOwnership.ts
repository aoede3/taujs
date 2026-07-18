import { dedupeMatchers, deriveBoundaries, mergeCompilerOptions, parseTsconfigProject, resolveProjectPath } from './tsconfigOwnership.js';

import type { OwnershipMatcher } from './tsconfigOwnership.js';
import type { ManagedGroupMember, PrepareInput } from '@taujs/server/config';

/**
 * ESC-1 - React ownership computation (RFC 0006). Turns a same-key group of `scopedPluginReact()`
 * contributions into the plan data the host needs: the union of each app's tsconfig `include` claims,
 * expected-owner boundaries, the projects' own `exclude`, and the deterministically-merged React
 * options. Loaded lazily by `prepare()` so `typescript` never loads for a raw `pluginReact()` user.
 *
 * React libraries ship precompiled JavaScript, so no node_modules packages are claimed (the classifier
 * is a deliberate no-op here; Solid differs - it ships JSX and derives package matchers via vitefu).
 */

export type ReactOwnership = {
  claims: OwnershipMatcher[];
  boundaries: OwnershipMatcher[];
  exclude: OwnershipMatcher[];
  options: Record<string, unknown>;
};

export const computeReactOwnership = (group: ReadonlyArray<ManagedGroupMember>, input: PrepareInput): ReactOwnership => {
  const options = mergeCompilerOptions('React', group.map((member) => (member.contribution.options ?? {}) as Record<string, unknown>));

  const claims: OwnershipMatcher[] = [];
  const boundaries: OwnershipMatcher[] = [];
  const exclude: OwnershipMatcher[] = [];

  for (const member of group) {
    const projectPath = resolveProjectPath(member.contribution.project, input.projectRoot);
    const { include, exclude: projectExclude } = parseTsconfigProject(projectPath);
    claims.push(...include);
    boundaries.push(...deriveBoundaries(include));
    exclude.push(...projectExclude);
  }

  return {
    claims: dedupeMatchers(claims),
    boundaries: dedupeMatchers(boundaries),
    exclude: dedupeMatchers(exclude),
    options,
  };
};
