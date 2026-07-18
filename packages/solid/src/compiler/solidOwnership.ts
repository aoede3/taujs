import { classifySolidPackages } from './solidClassifier.js';
import { dedupeMatchers, deriveBoundaries, mergeCompilerOptions, parseTsconfigProject, resolveProjectPath } from './tsconfigOwnership.js';

import type { OwnershipMatcher } from './tsconfigOwnership.js';
import type { ManagedGroupMember, PrepareInput } from '@taujs/server/config';

/**
 * ESC-1 - Solid ownership computation (RFC 0006). Turns a same-key group of `scopedPluginSolid()`
 * contributions into the plan data the host needs: the union of each app's tsconfig `include` claims
 * PLUS the exact node_modules Solid-package directories (vitefu classifier), expected-owner boundaries,
 * the projects' own `exclude`, and the deterministically-merged Solid options. Loaded lazily by
 * `prepare()` so `typescript`/`vitefu` never load for a raw `pluginSolid()` user.
 */

export type SolidOwnership = {
  claims: OwnershipMatcher[];
  boundaries: OwnershipMatcher[];
  exclude: OwnershipMatcher[];
  options: Record<string, unknown>;
};

export const computeSolidOwnership = async (group: ReadonlyArray<ManagedGroupMember>, input: PrepareInput): Promise<SolidOwnership> => {
  const options = mergeCompilerOptions('Solid', group.map((member) => (member.contribution.options ?? {}) as Record<string, unknown>));

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

  // Solid libraries in node_modules ship JSX and must be compiled: exact package-directory matchers.
  const packageClaims = await classifySolidPackages(input.projectRoot);
  claims.push(...packageClaims);

  return {
    claims: dedupeMatchers(claims),
    boundaries: dedupeMatchers(boundaries),
    exclude: dedupeMatchers(exclude),
    options,
  };
};
