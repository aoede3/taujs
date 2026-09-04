// @vitest-environment node
//
// RFC 0015 Phase B V1: version-locked contract lookup. Fixtures build a project root with a
// real installed-owner shape (node_modules/@taujs/server/{package.json,contracts/}) plus a graph
// emitted by the real composer and then version-patched, so alignment and mismatch are both
// exact. No dev.json anywhere: contracts and their citations must work against a stale graph.
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { createRequestGraph } from '../../../server/src/core/introspection/RequestGraph';
import { writeTaujsArtifact } from '../../../server/src/core/introspection/EmitGraph';

import { CONTRACT_BODY_CAP } from '../ContractReader';
import { allTools } from '../server';

import type { CoreTaujsConfig } from '../../../server/src/core/config/types';
import type { ToolResult } from '../toolkit';

const config: CoreTaujsConfig = {
  apps: [
    {
      appId: 'shop',
      entryPoint: '',
      routes: [{ path: '/', attr: { render: 'ssr' } }],
    },
  ],
};

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'taujs-mcp-contracts-'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const GOOD_MANIFEST = {
  schemaVersion: 1,
  owner: '@taujs/server',
  contracts: [{ id: 'server:render-strategies', title: 'Render strategies and the default', doc: 'render-strategies.md' }],
};
const GOOD_DOC = "# Render strategies\n\nThe runtime default is 'ssr'; there is no 'csr' value - client-only navigation exists by omission of a route.\n";

type FixtureOptions = {
  installedVersion?: string | null; // null: owner absent entirely
  pkgName?: string; // installed package's self-declared name
  graphServerVersion?: string | null; // null: no graph emitted
  graphRaw?: string; // write these raw bytes as graph.json (unreadable-graph cells)
  graphSchemaVersion?: number; // patch the graph's schemaVersion (skew cells)
  manifest?: unknown | null; // null: no contracts/ directory
  manifestRaw?: string; // overrides manifest with raw bytes
  doc?: string;
  docName?: string;
  symlinkOwner?: boolean; // install the owner via a symlink, pnpm-style
};

const mkFixture = async (opts: FixtureOptions = {}): Promise<string> => {
  const root = await mkdtemp(path.join(scratch, 'root-'));
  const installedVersion = opts.installedVersion === undefined ? '1.2.3' : opts.installedVersion;

  if (installedVersion !== null) {
    const realDir = opts.symlinkOwner ? path.join(root, '.store', 'server-pkg') : path.join(root, 'node_modules', '@taujs', 'server');
    await mkdir(realDir, { recursive: true });
    await writeFile(path.join(realDir, 'package.json'), JSON.stringify({ name: opts.pkgName ?? '@taujs/server', version: installedVersion }));
    if (opts.manifest !== null) {
      const contractsDir = path.join(realDir, 'contracts');
      await mkdir(contractsDir, { recursive: true });
      await writeFile(path.join(contractsDir, 'index.json'), opts.manifestRaw ?? JSON.stringify(opts.manifest ?? GOOD_MANIFEST));
      await writeFile(path.join(contractsDir, opts.docName ?? 'render-strategies.md'), opts.doc ?? GOOD_DOC);
    }
    if (opts.symlinkOwner) {
      await mkdir(path.join(root, 'node_modules', '@taujs'), { recursive: true });
      await symlink(realDir, path.join(root, 'node_modules', '@taujs', 'server'), 'dir');
    }
  }

  if (opts.graphRaw !== undefined) {
    await writeTaujsArtifact(path.join(root, 'node_modules', '.taujs'), 'graph.json', opts.graphRaw);
    return root;
  }
  const graphVersion = opts.graphServerVersion === undefined ? installedVersion : opts.graphServerVersion;
  if (graphVersion !== null) {
    const graph = createRequestGraph(config, { source: 'boot', emittedAt: '2026-09-01T10:00:00.000Z' });
    const patched = {
      ...graph,
      taujs: { ...graph.taujs, server: graphVersion },
      ...(opts.graphSchemaVersion !== undefined ? { schemaVersion: opts.graphSchemaVersion } : {}),
    };
    await writeTaujsArtifact(path.join(root, 'node_modules', '.taujs'), 'graph.json', JSON.stringify(patched, null, 2));
  }
  return root;
};

const call = (root: string, name: string, args: Record<string, unknown> = {}): any => {
  const handler = allTools(root).find((t) => t.name === name)?.handler as ((a: Record<string, unknown>) => ToolResult) | undefined;
  if (!handler) throw new Error(`unknown tool ${name}`);
  return handler(args);
};

describe('taujs_find_contract - catalogue and exact-id retrieval', () => {
  it('with no id returns the bounded catalogue with owner versions; retrieval needs the exact id', async () => {
    const root = await mkFixture();
    const result = call(root, 'taujs_find_contract');
    expect(result.ok).toBe(true);
    expect(result.catalogue.items).toEqual([
      expect.objectContaining({ id: 'server:render-strategies', title: 'Render strategies and the default', owner: '@taujs/server', ownerVersion: '1.2.3' }),
    ]);
    expect(result.catalogue.truncated).toBe(false);
    expect(result.contract).toBeUndefined();
  });

  it('an exact id returns body, citation and provenance, version-locked to the installed owner', async () => {
    const root = await mkFixture();
    const result = call(root, 'taujs_find_contract', { id: 'server:render-strategies' });
    expect(result.ok).toBe(true);
    expect(result.contract.body).toContain('client-only navigation exists by omission');
    expect(result.contract.truncated).toBe(false);
    expect(result.citation).toEqual({ contractId: 'server:render-strategies', owner: '@taujs/server', ownerVersion: '1.2.3' });
    expect(result.provenance.graphServerVersion).toBe('1.2.3');
  });

  it('an unknown id refuses with the known catalogue; ids cannot smuggle paths', async () => {
    const root = await mkFixture();
    const miss = call(root, 'taujs_find_contract', { id: 'server:nope' });
    expect(miss).toMatchObject({ ok: false, reason: 'unknown_contract' });
    expect(miss.knownIds.items).toEqual(['server:render-strategies']);

    const traversal = call(root, 'taujs_find_contract', { id: '../../package.json' });
    expect(traversal).toMatchObject({ ok: false, reason: 'unknown_contract' });
  });

  it('a graph/package version disagreement is a refusal with NO contract body', async () => {
    const root = await mkFixture({ installedVersion: '1.2.3', graphServerVersion: '9.9.9' });
    const result = call(root, 'taujs_find_contract', { id: 'server:render-strategies' });
    expect(result).toMatchObject({ ok: false, reason: 'version_mismatch', installedVersion: '1.2.3', graphServerVersion: '9.9.9' });
    expect(result.contract).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('client-only navigation');
  });

  it('a missing graph is not a disagreement: the contract serves with explicit provenance', async () => {
    const root = await mkFixture({ graphServerVersion: null });
    const result = call(root, 'taujs_find_contract', { id: 'server:render-strategies' });
    expect(result.ok).toBe(true);
    expect(result.provenance.graphServerVersion).toBe('no graph emitted');
  });

  it('an installed owner without contracts/ (older release) refuses contract_unavailable', async () => {
    const root = await mkFixture({ manifest: null });
    const result = call(root, 'taujs_find_contract', { id: 'server:render-strategies' });
    expect(result).toMatchObject({ ok: false, reason: 'contract_unavailable', owner: '@taujs/server', cause: 'contracts_missing' });
  });

  it('a manifest schema skew refuses contract_unavailable and is named in the catalogue answer', async () => {
    const root = await mkFixture({ manifest: { ...GOOD_MANIFEST, schemaVersion: 2 } });
    const retrieval = call(root, 'taujs_find_contract', { id: 'server:render-strategies' });
    expect(retrieval).toMatchObject({ ok: false, reason: 'contract_unavailable', owner: '@taujs/server', cause: 'manifest_schema_skew' });

    const catalogue = call(root, 'taujs_find_contract');
    expect(catalogue.ok).toBe(true);
    expect(catalogue.catalogue.items).toEqual([]);
    expect(catalogue.unavailableOwners).toEqual([expect.objectContaining({ owner: '@taujs/server', reason: 'manifest_schema_skew' })]);
  });

  it('an oversized body returns with an explicit truncated marker at the cap', async () => {
    const root = await mkFixture({ doc: 'x'.repeat(CONTRACT_BODY_CAP + 500) });
    const result = call(root, 'taujs_find_contract', { id: 'server:render-strategies' });
    expect(result.ok).toBe(true);
    expect(result.contract.truncated).toBe(true);
    expect(result.contract.body).toHaveLength(CONTRACT_BODY_CAP);
  });

  it('a pnpm-style symlinked owner install resolves', async () => {
    const root = await mkFixture({ symlinkOwner: true });
    const result = call(root, 'taujs_find_contract', { id: 'server:render-strategies' });
    expect(result.ok).toBe(true);
    expect(result.citation.ownerVersion).toBe('1.2.3');
  });

  it('a manifest doc entry cannot escape the contracts directory', async () => {
    const root = await mkFixture({ manifest: { ...GOOD_MANIFEST, contracts: [{ ...GOOD_MANIFEST.contracts[0], doc: '../package.json' }] } });
    const result = call(root, 'taujs_find_contract', { id: 'server:render-strategies' });
    expect(result).toMatchObject({ ok: false, reason: 'contract_unavailable', cause: 'doc_outside_contracts' });
  });

  it('an exact id for an owner that is not installed refuses contract_unavailable, not unknown_contract', async () => {
    const root = await mkFixture({ installedVersion: null, graphServerVersion: null });
    const result = call(root, 'taujs_find_contract', { id: 'server:render-strategies' });
    expect(result).toMatchObject({ ok: false, reason: 'contract_unavailable', owner: '@taujs/server', cause: 'owner_not_installed' });
  });

  it('an existing but UNREADABLE graph is a typed refusal with no body - never treated as absent', async () => {
    const root = await mkFixture({ graphRaw: 'this is not json {' });
    const result = call(root, 'taujs_find_contract', { id: 'server:render-strategies' });
    expect(result).toMatchObject({ ok: false, reason: 'graph_unusable' });
    expect(result.contract).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('client-only navigation');
  });

  it('an existing but schema-skewed graph is the same typed refusal with no body', async () => {
    const root = await mkFixture({ graphSchemaVersion: 99 });
    const result = call(root, 'taujs_find_contract', { id: 'server:render-strategies' });
    expect(result).toMatchObject({ ok: false, reason: 'graph_unusable' });
    expect(result.contract).toBeUndefined();
  });
});

describe('bounded reads and manifest identity', () => {
  it('a manifest over the byte cap refuses before parsing', async () => {
    const padded = { ...GOOD_MANIFEST, padding: 'x'.repeat(70_000) };
    const root = await mkFixture({ manifestRaw: JSON.stringify(padded) });
    const result = call(root, 'taujs_find_contract', { id: 'server:render-strategies' });
    expect(result).toMatchObject({ ok: false, reason: 'contract_unavailable', cause: 'manifest_too_large' });
  });

  it('a manifest over the entry cap refuses', async () => {
    const contracts = Array.from({ length: 101 }, (_, i) => ({ id: `server:c${i}`, title: `c${i}`, doc: 'render-strategies.md' }));
    const root = await mkFixture({ manifest: { ...GOOD_MANIFEST, contracts } });
    const result = call(root, 'taujs_find_contract', { id: 'server:c1' });
    expect(result).toMatchObject({ ok: false, reason: 'contract_unavailable', cause: 'manifest_too_large' });
  });

  it('an installed package that names itself differently refuses owner_identity_mismatch', async () => {
    const root = await mkFixture({ pkgName: '@evil/server' });
    const result = call(root, 'taujs_find_contract', { id: 'server:render-strategies' });
    expect(result).toMatchObject({ ok: false, reason: 'contract_unavailable', cause: 'owner_identity_mismatch' });
  });

  it('a manifest declaring a different owner refuses manifest_identity_mismatch', async () => {
    const root = await mkFixture({ manifest: { ...GOOD_MANIFEST, owner: '@taujs/react' } });
    const result = call(root, 'taujs_find_contract', { id: 'server:render-strategies' });
    expect(result).toMatchObject({ ok: false, reason: 'contract_unavailable', cause: 'manifest_identity_mismatch' });
  });

  it('a contract id without the owner prefix refuses manifest_identity_mismatch', async () => {
    const root = await mkFixture({ manifest: { ...GOOD_MANIFEST, contracts: [{ id: 'react:sneaky', title: 'x', doc: 'render-strategies.md' }] } });
    const result = call(root, 'taujs_find_contract', { id: 'server:render-strategies' });
    expect(result).toMatchObject({ ok: false, reason: 'contract_unavailable', cause: 'manifest_identity_mismatch' });
  });

  it('duplicate contract ids refuse manifest_identity_mismatch', async () => {
    const entry = GOOD_MANIFEST.contracts[0];
    const root = await mkFixture({ manifest: { ...GOOD_MANIFEST, contracts: [entry, entry] } });
    const result = call(root, 'taujs_find_contract', { id: 'server:render-strategies' });
    expect(result).toMatchObject({ ok: false, reason: 'contract_unavailable', cause: 'manifest_identity_mismatch' });
  });

  it('a schema-v2 graph WITHOUT a usable taujs.server is graph_unusable, never served-as-absent', async () => {
    // Passes readGraph (parse + schemaVersion are its only checks) yet carries no emitter version.
    const root = await mkFixture({ graphRaw: '{"schemaVersion":2}' });
    const result = call(root, 'taujs_find_contract', { id: 'server:render-strategies' });
    expect(result).toMatchObject({ ok: false, reason: 'graph_unusable', cause: 'missing_emitter_version' });
    expect(result.contract).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('client-only navigation');
  });

  it('a path-shaped owner-prefixed id in the manifest is refused as malformed identity', async () => {
    const root = await mkFixture({ manifest: { ...GOOD_MANIFEST, contracts: [{ id: 'server:../../x', title: 'x', doc: 'render-strategies.md' }] } });
    const result = call(root, 'taujs_find_contract', { id: 'server:render-strategies' });
    expect(result).toMatchObject({ ok: false, reason: 'contract_unavailable', cause: 'manifest_identity_mismatch' });
  });

  it('an implausible package version refuses, and the oversized value never enters the response', async () => {
    const huge = 'x'.repeat(10_000);
    const root = await mkFixture({ installedVersion: huge, graphServerVersion: null });
    const result = call(root, 'taujs_find_contract', { id: 'server:render-strategies' });
    expect(result).toMatchObject({ ok: false, reason: 'contract_unavailable', cause: 'owner_not_installed' });
    expect(JSON.stringify(result)).not.toContain(huge.slice(0, 600));
    expect(JSON.stringify(result).length).toBeLessThan(2_000);
  });
});

describe('render-strategy citations - enrichment only, never a gate on existing facts', () => {
  it('explain_route and doctor cite the contract when the installed owner matches the graph', async () => {
    const root = await mkFixture();
    const explained = call(root, 'taujs_explain_route', { path: '/' });
    expect(explained.ok).toBe(true);
    expect(explained.explanations[0].render.contract).toEqual({ contractId: 'server:render-strategies', owner: '@taujs/server', ownerVersion: '1.2.3' });

    const doctor = call(root, 'taujs_doctor');
    expect(doctor.ok).toBe(true);
    expect(doctor.defaultedRenders.contract).toEqual({ contractId: 'server:render-strategies', owner: '@taujs/server', ownerVersion: '1.2.3' });
  });

  it('a citation is never emitted for a document retrieval could not serve', async () => {
    // Manifest entry names a document that does not exist: the shared exact-contract resolver
    // fails, so the citation is removed while the graph facts keep flowing.
    const root = await mkFixture({ manifest: { ...GOOD_MANIFEST, contracts: [{ ...GOOD_MANIFEST.contracts[0], doc: 'missing.md' }] } });
    const explained = call(root, 'taujs_explain_route', { path: '/' });
    expect(explained.ok).toBe(true);
    expect(explained.explanations[0].render.strategy).toBe('ssr');
    expect(explained.explanations[0].render.contract).toBeUndefined();
  });

  it('on a mismatched or contract-less installation the citation is absent and every existing fact still flows', async () => {
    for (const root of [await mkFixture({ installedVersion: '1.2.3', graphServerVersion: '9.9.9' }), await mkFixture({ manifest: null })]) {
      const explained = call(root, 'taujs_explain_route', { path: '/' });
      expect(explained.ok).toBe(true);
      expect(explained.explanations[0].render.strategy).toBe('ssr');
      expect(explained.explanations[0].render.contract).toBeUndefined();

      const doctor = call(root, 'taujs_doctor');
      expect(doctor.ok).toBe(true);
      expect(doctor.defaultedRenders.routeIds).toEqual([]);
      expect(doctor.defaultedRenders.contract).toBeUndefined();
    }
  });
});
