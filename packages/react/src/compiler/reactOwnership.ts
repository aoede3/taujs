import {
  assertNoExclusionConflicts,
  dedupeMatchers,
  deriveBoundaries,
  mergeCompilerOptions,
  parseTsconfigProject,
  resolveProjectPath,
} from './tsconfigOwnership.js';

import type { OwnershipMatcher, ProjectOwnership } from './tsconfigOwnership.js';
import type { ManagedGroupMember, PrepareInput } from '@taujs/server/renderer';

/**
 * ESC-1 - React ownership computation (RFC 0006). Turns a same-key group of `reactRenderer()`'s managed
 * compiler contributions into the plan data the host needs: the union of each app's tsconfig `include` claims,
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
  const options = mergeCompilerOptions(
    'React',
    group.map((member) => (member.contribution.options ?? {}) as Record<string, unknown>),
  );

  const projects: ProjectOwnership[] = [];
  const boundaries: OwnershipMatcher[] = [];

  for (const member of group) {
    const projectPath = resolveProjectPath(member.contribution.project, input.projectRoot);
    const { include, exclude } = parseTsconfigProject(projectPath);
    projects.push({ project: projectPath, include, exclude });
    boundaries.push(...deriveBoundaries(include));
  }

  // React claims no node_modules packages (libraries ship precompiled), so classifierClaims is empty;
  // still reject a project excluding what another React project claims (silent same-key false-green).
  assertNoExclusionConflicts('React', projects, []);

  return {
    claims: dedupeMatchers(projects.flatMap((p) => p.include)),
    boundaries: dedupeMatchers(boundaries),
    exclude: dedupeMatchers(projects.flatMap((p) => p.exclude)),
    options,
  };
};
