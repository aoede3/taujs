// @vitest-environment node
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

type ContractEntry = { id: string; doc: string };
type ContractManifest = { contracts: ContractEntry[] };

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const CONTRACT_TOKEN = /\bcontract:/g;
const CONTRACT_CITATION = /\bcontract:\s*([a-z]+:[a-z0-9]+(?:-[a-z0-9]+)*(?:#[a-z0-9]+(?:-[a-z0-9]+)*)?)/g;
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)]+)\)/g;

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const walkSource = (dir: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === '__tests__') continue;
      files.push(...walkSource(path.join(dir, entry.name)));
      continue;
    }
    if (entry.isFile() && SOURCE_FILE.test(entry.name) && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.test.tsx'))
      files.push(path.join(dir, entry.name));
  }
  return files;
};

// GitHub's heading anchors for the deliberately plain headings used by the contract corpus.
const headingSlug = (heading: string): string =>
  heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, '-');

const headingsIn = (file: string): Set<string> => {
  const headings = new Set<string>();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) headings.add(headingSlug(match[1]!));
  }
  return headings;
};

const validateRelativeLinks = (repoRoot: string, file: string): string[] => {
  const errors: string[] = [];
  const body = readFileSync(file, 'utf8');
  for (const match of body.matchAll(MARKDOWN_LINK)) {
    const destination = match[1]!
      .trim()
      .replace(/^<|>$/g, '')
      .split(/\s+["']/)[0]!;
    if (!destination || destination.startsWith('#') || destination.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(destination)) continue;
    const target = decodeURIComponent(destination.split('#')[0]!);
    const resolved = path.resolve(path.dirname(file), target);
    if (!existsSync(resolved) || !statSync(resolved).isFile()) errors.push(`${path.relative(repoRoot, file)}: relative link does not resolve: ${destination}`);
  }
  return errors;
};

const validateCorpus = (repoRoot: string, serverDir: string): string[] => {
  const errors: string[] = [];
  const contractsDir = path.join(serverDir, 'contracts');
  const manifest = JSON.parse(readFileSync(path.join(contractsDir, 'index.json'), 'utf8')) as ContractManifest;
  const entries = new Map(manifest.contracts.map((entry) => [entry.id, entry]));
  const headingCache = new Map<string, Set<string>>();

  for (const sourceFile of walkSource(path.join(serverDir, 'src'))) {
    const body = readFileSync(sourceFile, 'utf8');
    const tokens = [...body.matchAll(CONTRACT_TOKEN)];
    const citations = [...body.matchAll(CONTRACT_CITATION)];
    const sourceName = path.relative(repoRoot, sourceFile);
    if (tokens.length !== citations.length) errors.push(`${sourceName}: malformed contract: citation`);

    for (const match of citations) {
      const citation = match[1]!;
      const [id, anchor] = citation.split('#') as [string, string?];
      if (!id.startsWith('server:')) {
        errors.push(`${sourceName}: cross-owner citation ${citation} is outside this pilot; only server: ids are allowed`);
        continue;
      }
      const entry = entries.get(id);
      if (!entry) {
        errors.push(`${sourceName}: contract id is not in the server manifest: ${id}`);
        continue;
      }
      if (!anchor) {
        errors.push(`${sourceName}: citation must name a heading anchor: ${id}`);
        continue;
      }
      const document = path.join(contractsDir, entry.doc);
      if (!existsSync(document)) {
        errors.push(`${sourceName}: contract document does not exist: ${entry.doc}`);
        continue;
      }
      let headings = headingCache.get(document);
      if (!headings) {
        headings = headingsIn(document);
        headingCache.set(document, headings);
      }
      if (!headings.has(anchor)) errors.push(`${sourceName}: contract anchor does not exist: ${id}#${anchor}`);
    }
  }

  for (const entry of manifest.contracts) {
    const document = path.join(contractsDir, entry.doc);
    if (!existsSync(document)) errors.push(`manifest: contract document does not exist: ${entry.doc}`);
  }

  for (const file of readdirSync(contractsDir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => path.join(contractsDir, name)))
    errors.push(...validateRelativeLinks(repoRoot, file));
  const rootRegister = path.join(repoRoot, 'contracts', 'README.md');
  if (!existsSync(rootRegister)) errors.push('contracts/README.md: root contract register does not exist');
  else errors.push(...validateRelativeLinks(repoRoot, rootRegister));

  return errors;
};

describe('contract citations', () => {
  it('every production citation and contract link resolves', () => {
    expect(validateCorpus(REPO_ROOT, SERVER_DIR)).toEqual([]);
  });

  it('rejects a bare citation and one whose anchor is absent from the contract document', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'taujs-contract-citations-'));
    scratchDirs.push(root);
    const server = path.join(root, 'packages', 'server');
    mkdirSync(path.join(server, 'src'), { recursive: true });
    mkdirSync(path.join(server, 'contracts'), { recursive: true });
    mkdirSync(path.join(root, 'contracts'), { recursive: true });
    writeFileSync(path.join(server, 'contracts', 'index.json'), JSON.stringify({ contracts: [{ id: 'server:request-identity', doc: 'request-identity.md' }] }));
    writeFileSync(path.join(server, 'contracts', 'request-identity.md'), '# Request identity\n\n### Ruling 1: canonical identity\n');
    writeFileSync(path.join(root, 'contracts', 'README.md'), '# Contract register\n');
    const source = path.join(server, 'src', 'identity.ts');
    writeFileSync(source, '// contract: server:request-identity\n');
    expect(validateCorpus(root, server)).toContain('packages/server/src/identity.ts: citation must name a heading anchor: server:request-identity');

    writeFileSync(source, '// contract: server:request-identity#missing-anchor\n');

    expect(validateCorpus(root, server)).toContain('packages/server/src/identity.ts: contract anchor does not exist: server:request-identity#missing-anchor');

    writeFileSync(source, '// contract: server:request-identity#ruling-1-canonical-identity\n');
    expect(validateCorpus(root, server)).toEqual([]);
  });
});
