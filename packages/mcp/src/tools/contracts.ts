import { z } from 'zod';

import { CONTRACT_OWNERS, ownerIdPrefix, resolveExactContract, resolveOwner } from '../ContractReader';
import { discoverSubstrate, readGraph } from '../SubstrateReader';
import { UNTRUSTED_NOTE, bounded, defineTool } from '../toolkit';

import type { ContractCatalogueEntry, ContractOwner } from '../ContractReader';
import type { ToolDefinition, ToolResult } from '../toolkit';

const CATALOGUE_LIMIT = 50;

// Version lock (RFC 0015 R3, Phase B rules): a contract is served only for the installed owner
// version, and - for @taujs/server - only when the graph's emitter version agrees with the
// installed package. Disagreement is a REFUSAL with no contract body. Three graph states are
// distinguished: genuinely absent (serve, with explicit provenance), readable (compare), and
// existing-but-unusable (unreadable or schema-skewed: a typed refusal with no body - an
// unusable graph is not an absent one).
type GraphState = { kind: 'version'; server: string } | { kind: 'none' } | { kind: 'unusable'; cause: string; message: string };

const graphState = (root: string): GraphState => {
  const discovery = discoverSubstrate(root);
  if (discovery.mode === 'none') return { kind: 'none' };
  const result = readGraph(discovery);
  if (!result.ok) return { kind: 'unusable', cause: result.reason, message: result.message };
  // A graph that EXISTS but carries no usable emitter version cannot participate in the version
  // lock - and only a genuinely absent graph is approved to serve without one.
  const server = result.graph.taujs?.server;
  if (typeof server !== 'string' || server.length === 0)
    return { kind: 'unusable', cause: 'missing_emitter_version', message: 'A graph exists but carries no usable taujs.server emitter version.' };
  return { kind: 'version', server };
};

const ownerForId = (id: string): ContractOwner | undefined => CONTRACT_OWNERS.find((o) => id.startsWith(ownerIdPrefix(o)));

const catalogueFor = (root: string): { entries: ContractCatalogueEntry[]; unavailable: Array<{ owner: string; reason: string; detail?: string }> } => {
  const entries: ContractCatalogueEntry[] = [];
  const unavailable: Array<{ owner: string; reason: string; detail?: string }> = [];
  for (const owner of CONTRACT_OWNERS) {
    const resolved = resolveOwner(root, owner);
    if (!resolved.ok) {
      // An owner that simply is not installed is unremarkable in the CATALOGUE (most projects
      // install one renderer); an installed owner whose contracts are missing or unservable is
      // worth a line. Exact-id retrieval reports owner_not_installed through its own path.
      if (resolved.reason !== 'owner_not_installed') unavailable.push({ owner, reason: resolved.reason, ...(resolved.detail ? { detail: resolved.detail } : {}) });
      continue;
    }
    for (const entry of resolved.entries)
      entries.push({
        id: entry.id,
        title: entry.title,
        owner,
        ownerVersion: resolved.version,
        ...(entry.appliesTo ? { appliesTo: entry.appliesTo } : {}),
        ...(entry.related ? { related: entry.related } : {}),
      });
  }
  return { entries, unavailable };
};

export const contractTools = (root: string): ToolDefinition[] => [
  defineTool({
    name: 'taujs_find_contract',
    title: 'Find a τjs contract',
    description:
      `Version-locked contract lookup from the installed τjs packages. Without an id: a bounded catalogue of available contracts. With an exact id: that contract's body and citation, served only when the installed owner version is coherent with the emitted graph. No topic search - retrieval requires the exact id from the catalogue. ${UNTRUSTED_NOTE}`,
    inputSchema: z.object({
      id: z.string().max(200).optional().describe('Exact contract id from the catalogue, e.g. "server:render-strategies"'),
    }),
    handler: (args): ToolResult => {
      const { entries, unavailable } = catalogueFor(root);

      if (args.id === undefined) {
        return {
          ok: true,
          catalogue: bounded(entries, CATALOGUE_LIMIT),
          ...(unavailable.length ? { unavailableOwners: unavailable } : {}),
          note: 'Retrieve a contract by exact id. Contract versions are the installed owner package versions.',
        };
      }

      // An id without an allowlisted owner prefix can never resolve - and can never form a path.
      const owner = ownerForId(args.id);
      if (!owner) {
        return {
          ok: false,
          reason: 'unknown_contract',
          message: `No contract with id "${args.id}" among the installed packages' catalogues.`,
          knownIds: bounded(
            entries.map((e) => e.id),
            CATALOGUE_LIMIT,
          ),
          ...(unavailable.length ? { unavailableOwners: unavailable } : {}),
        };
      }

      const resolution = resolveExactContract(root, owner, args.id);
      if (!resolution.ok) {
        if (resolution.cause === 'unknown_id')
          return {
            ok: false,
            reason: 'unknown_contract',
            message: `No contract with id "${args.id}" in ${owner}'s catalogue.`,
            knownIds: bounded(
              entries.map((e) => e.id),
              CATALOGUE_LIMIT,
            ),
          };
        return { ok: false, reason: 'contract_unavailable', owner, cause: resolution.cause, ...(resolution.detail ? { detail: resolution.detail } : {}) };
      }

      // The version lock, applied before any body is served.
      const graph = graphState(root);
      if (owner === '@taujs/server') {
        if (graph.kind === 'unusable')
          return {
            ok: false,
            reason: 'graph_unusable',
            message: `A graph exists but cannot be used for the version lock: ${graph.message}`,
            cause: graph.cause,
          };
        if (graph.kind === 'version' && graph.server !== undefined && graph.server !== resolution.version)
          return {
            ok: false,
            reason: 'version_mismatch',
            message: `The emitted graph came from @taujs/server ${graph.server} but ${resolution.version} is installed. Re-emit the graph (boot or build) before trusting contract-backed answers.`,
            installedVersion: resolution.version,
            graphServerVersion: graph.server,
          };
      }

      return {
        ok: true,
        contract: { id: resolution.id, title: resolution.title, owner, ownerVersion: resolution.version, body: resolution.body, truncated: resolution.truncated },
        citation: { contractId: resolution.id, owner, ownerVersion: resolution.version },
        provenance: {
          resolvedFrom: `node_modules/${owner}/contracts/`,
          installedVersion: resolution.version,
          graphServerVersion: graph.kind === 'version' ? graph.server : graph.kind === 'none' ? 'no graph emitted' : 'graph unusable',
        },
      };
    },
  }),
];

// Enrichment-only citation for render-strategy statements in existing read-only tools. Returns
// undefined - leaving those tools' current facts untouched - unless the ONE exact-contract
// resolver fully serves the contract (owner, manifest, entry AND document) and the graph's
// emitter version agrees with the installed package. A citation can never point at a document
// retrieval could not serve; failed resolution removes only the citation, never a graph fact.
export const renderStrategyCitation = (root: string, graphServer: string | undefined): { contractId: string; owner: ContractOwner; ownerVersion: string } | undefined => {
  if (graphServer === undefined) return undefined;
  const resolution = resolveExactContract(root, '@taujs/server', 'server:render-strategies');
  if (!resolution.ok || resolution.version !== graphServer) return undefined;
  return { contractId: resolution.id, owner: '@taujs/server', ownerVersion: resolution.version };
};
