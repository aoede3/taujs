import { classifySolidPackages } from './solidClassifier.js';
import { assertNoExclusionConflicts, dedupeMatchers, deriveBoundaries, mergeCompilerOptions, parseTsconfigProject, resolveProjectPath } from './tsconfigOwnership.js';

import type { OwnershipMatcher, ProjectOwnership } from './tsconfigOwnership.js';
import type { ManagedGroupMember, PrepareInput } from '@taujs/server/renderer';

/**
 * ESC-1 - Solid ownership computation (RFC 0006). Turns a same-key group of the internal Solid managed
 * compiler contributions into the plan data the host needs: the union of each app's tsconfig `include` claims
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

  const projects: ProjectOwnership[] = [];
  const boundaries: OwnershipMatcher[] = [];

  for (const member of group) {
    const projectPath = resolveProjectPath(member.contribution.project, input.projectRoot);
    const { include, exclude } = parseTsconfigProject(projectPath);
    projects.push({ project: projectPath, include, exclude });
    boundaries.push(...deriveBoundaries(include));
  }

  // Solid libraries in node_modules ship JSX and must be compiled: exact package-directory matchers.
  const packageClaims = await classifySolidPackages(input.projectRoot);

  // Reject a project excluding what another project (or the classifier's packages) claims - one project's
  // exclude must not silently cancel another's ownership in the merged filter.
  assertNoExclusionConflicts('Solid', projects, packageClaims);

  return {
    claims: dedupeMatchers([...projects.flatMap((p) => p.include), ...packageClaims]),
    boundaries: dedupeMatchers(boundaries),
    exclude: dedupeMatchers(projects.flatMap((p) => p.exclude)),
    options,
  };
};
