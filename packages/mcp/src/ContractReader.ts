// Package-owned contract resolution (RFC 0015 Phase B V1). Filesystem-only, read-only, no
// runtime dependency on any owner package - the JSON manifest and schemaVersion checks guard
// drift exactly as the graph's do.
//
// Resolution happens beneath a FIXED allowlist of package roots: `<root>/node_modules/<owner>`
// for the first-party owners only. Owner names and contract paths NEVER come from tool input -
// input selects among allowlisted owners and manifest-listed ids. Workspace/pnpm symlinks are
// legitimate (the lookup path is fixed; its realpath target may live anywhere), but a manifest
// `doc` entry must resolve to a regular file INSIDE the owner's real contracts/ directory, so a
// hostile or corrupt manifest cannot walk out of it.
//
// Every file read is BOUNDED at the read, not at the output: a byte cap is enforced through a
// file descriptor before any parse, so an oversized manifest or document never fully enters
// memory. Identity is validated end to end: the installed package must carry the allowlisted
// name, the manifest must declare that owner, and every id must carry the owner's prefix and be
// unique within its manifest.
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

export const CONTRACT_OWNERS = ['@taujs/server', '@taujs/react', '@taujs/vue', '@taujs/solid'] as const;
export type ContractOwner = (typeof CONTRACT_OWNERS)[number];

// The id prefix an owner's contracts must carry: '@taujs/server' -> 'server:'.
export const ownerIdPrefix = (owner: ContractOwner): string => `${owner.replace('@taujs/', '')}:`;

export const CONTRACT_MANIFEST_SCHEMA_VERSION = 1;

// The complete owner-scoped kebab form: `<owner-short>:<kebab-segment>`. Nothing path-shaped
// or otherwise malformed survives identity validation, prefix aside.
export const CONTRACT_ID_FORM = /^[a-z]+:[a-z0-9]+(-[a-z0-9]+)*$/;

// Metadata value bounds (finding: file reads were bounded, metadata values were not). The house
// string cap applies to every detail string returned; versions are additionally semver-plausible.
const VERSION_LENGTH_CAP = 64;
const DETAIL_CAP = 500;
const capDetail = (value: string): string => (value.length > DETAIL_CAP ? value.slice(0, DETAIL_CAP) : value);

// Bounded body: large enough for any sane contract document, explicit when it is not.
export const CONTRACT_BODY_CAP = 16_000;
// Bounded manifest: bytes before parse, entries after.
export const MANIFEST_BYTE_CAP = 65_536;
export const MANIFEST_ENTRY_CAP = 100;
// package.json read cap - it is read only for name and version.
const PACKAGE_JSON_BYTE_CAP = 262_144;

const manifestSchema = z.object({
  schemaVersion: z.number(),
  owner: z.string().min(1).max(100),
  contracts: z.array(
    z.object({
      id: z.string().min(1).max(200),
      title: z.string().min(1).max(300),
      doc: z.string().min(1).max(300),
      appliesTo: z.array(z.string().max(300)).max(50).optional(),
      related: z.array(z.string().max(200)).max(50).optional(),
    }),
  ),
});

export type ContractCatalogueEntry = {
  id: string;
  title: string;
  owner: ContractOwner;
  ownerVersion: string;
  appliesTo?: string[];
  related?: string[];
};

export type OwnerFailureReason =
  | 'owner_not_installed'
  | 'owner_identity_mismatch'
  | 'contracts_missing'
  | 'manifest_unreadable'
  | 'manifest_too_large'
  | 'manifest_identity_mismatch'
  | 'manifest_schema_skew';

export type OwnerResolution =
  | { ok: true; owner: ContractOwner; version: string; contractsDir: string; entries: z.infer<typeof manifestSchema>['contracts'] }
  | { ok: false; owner: ContractOwner; reason: OwnerFailureReason; detail?: string };

// Bounded read through a descriptor: at most maxBytes + 1 bytes leave the file, and `exceeded`
// reports whether the file held more. Close in finally (bounded-reader discipline).
const readFileBounded = (file: string, maxBytes: number): { content: string; exceeded: boolean } => {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes + 1, 0);
    return { content: buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString('utf8'), exceeded: bytesRead > maxBytes };
  } finally {
    fs.closeSync(fd);
  }
};

// Resolve one allowlisted owner beneath the project root. The lookup path is fixed; realpath is
// taken for the containment check on manifest-named documents, not to admit input-derived paths.
export const resolveOwner = (root: string, owner: ContractOwner): OwnerResolution => {
  const lookupDir = path.join(root, 'node_modules', ...owner.split('/'));
  let pkgDir: string;
  let version: string;
  try {
    pkgDir = fs.realpathSync(lookupDir);
    const pkgRead = readFileBounded(path.join(pkgDir, 'package.json'), PACKAGE_JSON_BYTE_CAP);
    if (pkgRead.exceeded) return { ok: false, owner, reason: 'owner_not_installed', detail: 'package.json exceeds the read bound' };
    const pkg = JSON.parse(pkgRead.content) as { name?: unknown; version?: unknown };
    if (pkg.name !== owner)
      return { ok: false, owner, reason: 'owner_identity_mismatch', detail: capDetail(`installed package names itself ${String(pkg.name).slice(0, 100)}`) };
    if (typeof pkg.version !== 'string' || pkg.version.length === 0 || pkg.version.length > VERSION_LENGTH_CAP)
      return { ok: false, owner, reason: 'owner_not_installed', detail: 'package.json version is missing or implausible' };
    version = pkg.version;
  } catch {
    return { ok: false, owner, reason: 'owner_not_installed' };
  }

  const contractsDir = path.join(pkgDir, 'contracts');
  const manifestPath = path.join(contractsDir, 'index.json');
  if (!fs.existsSync(manifestPath)) return { ok: false, owner, reason: 'contracts_missing', detail: `installed ${owner}@${version} ships no contracts/` };

  let parsed: z.infer<typeof manifestSchema>;
  try {
    const manifestRead = readFileBounded(manifestPath, MANIFEST_BYTE_CAP);
    if (manifestRead.exceeded) return { ok: false, owner, reason: 'manifest_too_large', detail: `manifest exceeds ${MANIFEST_BYTE_CAP} bytes` };
    const result = manifestSchema.safeParse(JSON.parse(manifestRead.content));
    if (!result.success) return { ok: false, owner, reason: 'manifest_schema_skew', detail: 'manifest does not match the expected shape' };
    parsed = result.data;
  } catch {
    return { ok: false, owner, reason: 'manifest_unreadable' };
  }
  if (parsed.schemaVersion !== CONTRACT_MANIFEST_SCHEMA_VERSION)
    return {
      ok: false,
      owner,
      reason: 'manifest_schema_skew',
      detail: `manifest schemaVersion ${parsed.schemaVersion}; this adapter understands ${CONTRACT_MANIFEST_SCHEMA_VERSION}`,
    };
  if (parsed.owner !== owner) return { ok: false, owner, reason: 'manifest_identity_mismatch', detail: `manifest declares owner ${parsed.owner}` };
  if (parsed.contracts.length > MANIFEST_ENTRY_CAP)
    return { ok: false, owner, reason: 'manifest_too_large', detail: `manifest lists ${parsed.contracts.length} contracts; the cap is ${MANIFEST_ENTRY_CAP}` };
  const malformedId = parsed.contracts.find((c) => !CONTRACT_ID_FORM.test(c.id));
  if (malformedId)
    return { ok: false, owner, reason: 'manifest_identity_mismatch', detail: capDetail(`contract id "${malformedId.id}" is not owner-scoped kebab form`) };
  const prefix = ownerIdPrefix(owner);
  const badId = parsed.contracts.find((c) => !c.id.startsWith(prefix));
  if (badId)
    return {
      ok: false,
      owner,
      reason: 'manifest_identity_mismatch',
      detail: capDetail(`contract id "${badId.id}" does not carry the owner prefix "${prefix}"`),
    };
  if (new Set(parsed.contracts.map((c) => c.id)).size !== parsed.contracts.length)
    return { ok: false, owner, reason: 'manifest_identity_mismatch', detail: 'duplicate contract ids in the manifest' };

  return { ok: true, owner, version, contractsDir, entries: parsed.contracts };
};

export type ContractBodyRead = { ok: true; body: string; truncated: boolean } | { ok: false; reason: 'doc_outside_contracts' | 'doc_unreadable' };

// The manifest names the document; the document must be a regular file whose realpath stays
// inside the owner's real contracts/ directory. The read itself is bounded at the body cap.
export const readContractBody = (contractsDir: string, doc: string): ContractBodyRead => {
  try {
    const realContractsDir = fs.realpathSync(contractsDir);
    const target = fs.realpathSync(path.join(contractsDir, doc));
    if (target !== path.join(realContractsDir, path.basename(target)) || !fs.statSync(target).isFile()) return { ok: false, reason: 'doc_outside_contracts' };
    const read = readFileBounded(target, CONTRACT_BODY_CAP);
    return { ok: true, body: read.content.slice(0, CONTRACT_BODY_CAP), truncated: read.exceeded };
  } catch {
    return { ok: false, reason: 'doc_unreadable' };
  }
};

export type ExactContractResolution =
  | { ok: true; owner: ContractOwner; version: string; id: string; title: string; body: string; truncated: boolean }
  | { ok: false; owner: ContractOwner; cause: OwnerFailureReason | 'unknown_id' | 'doc_outside_contracts' | 'doc_unreadable'; detail?: string };

// The ONE exact-contract resolver, shared by retrieval and citation enrichment: a contract is
// resolved only when its owner, manifest, entry AND document all check out - a citation can
// never point at a document retrieval could not serve.
export const resolveExactContract = (root: string, owner: ContractOwner, id: string): ExactContractResolution => {
  const resolved = resolveOwner(root, owner);
  if (!resolved.ok) return { ok: false, owner, cause: resolved.reason, ...(resolved.detail ? { detail: resolved.detail } : {}) };
  const entry = resolved.entries.find((e) => e.id === id);
  if (!entry) return { ok: false, owner, cause: 'unknown_id' };
  const body = readContractBody(resolved.contractsDir, entry.doc);
  if (!body.ok) return { ok: false, owner, cause: body.reason };
  return { ok: true, owner, version: resolved.version, id: entry.id, title: entry.title, body: body.body, truncated: body.truncated };
};
