// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import fastify from 'fastify';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// One-shot gate for the close-ordering regression cell: when armed, the NEXT dev-file write
// blocks until released - a deterministically in-flight write, no timing games. All other
// writes pass straight through to the real implementation.
const writeGate = vi.hoisted(() => ({
  armed: false,
  held: Promise.resolve() as Promise<void>,
  heldStarts: 0,
}));

vi.mock('../EmitGraph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../EmitGraph')>();
  return {
    ...actual,
    writeTaujsArtifact: async (...args: Parameters<typeof actual.writeTaujsArtifact>) => {
      if (writeGate.armed) {
        writeGate.armed = false;
        writeGate.heldStarts += 1;
        await writeGate.held;
      }
      return actual.writeTaujsArtifact(...args);
    },
  };
});

import { createDevIntrospection } from '../DevIntrospection';
import { registerDevFiles } from '../DevFiles';
import { registerIntrospectionEndpoints } from '../DevEndpoints';

import type { CoreTaujsConfig } from '../../config/types';
import type { DevIntrospection } from '../DevIntrospection';

const config: CoreTaujsConfig = {
  apps: [{ appId: 'web', entryPoint: 'web', routes: [{ path: '/', attr: { render: 'ssr' } }] }],
};

const mkLogger = (): any => {
  const l: any = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), isDebugEnabled: vi.fn(() => false) };
  l.child = vi.fn(() => l);
  return l;
};

const buildApp = async (opts?: { taujsConfig?: CoreTaujsConfig; introspection?: DevIntrospection; allowedHosts?: ReadonlySet<string> }) => {
  const introspection = opts?.introspection ?? createDevIntrospection();
  const app = fastify();
  const logger = mkLogger();
  registerIntrospectionEndpoints(app, { introspection, taujsConfig: opts?.taujsConfig ?? config, allowedHosts: opts?.allowedHosts, logger });
  return { app, introspection, logger };
};

const LOOPBACK = '127.0.0.1';

const authed = (introspection: DevIntrospection, extra: Record<string, unknown> = {}) => ({
  remoteAddress: LOOPBACK,
  headers: { host: 'localhost:3000', 'x-taujs-token': introspection.token },
  ...extra,
});

describe('overlay endpoint guard stack (spec 03 §6, guard order)', () => {
  it('rejects non-loopback remote addresses by default', async () => {
    const { app, introspection } = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/__taujs/graph', ...authed(introspection, { remoteAddress: '192.168.1.20' }) });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'loopback_only' });
  });

  it('allowNonLoopback admits remote addresses but never relaxes host or token', async () => {
    const withFlag: CoreTaujsConfig = { ...config, introspection: { allowNonLoopback: true } };
    const { app, introspection } = await buildApp({ taujsConfig: withFlag });

    const ok = await app.inject({
      method: 'GET',
      url: '/__taujs/graph',
      remoteAddress: '192.168.1.20',
      headers: { host: '192.168.1.5:3000', 'x-taujs-token': introspection.token },
    });
    expect(ok.statusCode).toBe(200);

    const badHost = await app.inject({
      method: 'GET',
      url: '/__taujs/graph',
      remoteAddress: '192.168.1.20',
      headers: { host: 'evil.example.com', 'x-taujs-token': introspection.token },
    });
    expect(badHost.statusCode).toBe(403);

    const badToken = await app.inject({
      method: 'GET',
      url: '/__taujs/graph',
      remoteAddress: '192.168.1.20',
      headers: { host: '192.168.1.5:3000', 'x-taujs-token': 'wrong' },
    });
    expect(badToken.statusCode).toBe(403);
  });

  it('rejects DNS-rebindable hosts and missing/wrong tokens on loopback too', async () => {
    const { app, introspection } = await buildApp();

    const rebind = await app.inject({
      method: 'GET',
      url: '/__taujs/observations',
      remoteAddress: LOOPBACK,
      headers: { host: 'evil.example.com', 'x-taujs-token': introspection.token },
    });
    expect(rebind.statusCode).toBe(403);
    expect(rebind.json()).toEqual({ error: 'invalid_host' });

    const noToken = await app.inject({
      method: 'GET',
      url: '/__taujs/observations',
      remoteAddress: LOOPBACK,
      headers: { host: 'localhost:3000' },
    });
    expect(noToken.statusCode).toBe(403);
    expect(noToken.json()).toEqual({ error: 'invalid_token' });
  });

  it('accepts localhost, IP-literal, and IPv6 bracket hosts', async () => {
    const { app, introspection } = await buildApp();

    for (const host of ['localhost:5173', '127.0.0.1:5173', '[::1]:5173', 'app.localhost:5173']) {
      const res = await app.inject({
        method: 'GET',
        url: '/__taujs/observations',
        ...authed(introspection, { headers: { host, 'x-taujs-token': introspection.token } }),
      });
      expect(res.statusCode, host).toBe(200);
    }
  });
});

// Post-freeze ruling 2026-08-08 (docs/introspection/decisions.md): declared host admissions
// for proxied development. The set arrives resolved (lowercase, validated at createServer
// entry); these cells prove exact-match semantics, guard independence, and the warn-once
// rejection logging at the point of measured failure.
describe('declared host admissions (post-freeze ruling 2026-08-08)', () => {
  const DECLARED = new Set(['web.plt.local']);

  const injectHost = (app: any, introspection: DevIntrospection, host: string, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'GET',
      url: '/__taujs/observations',
      remoteAddress: LOOPBACK,
      headers: { host, 'x-taujs-token': introspection.token },
      ...extra,
    });

  it('admits a declared hostname - case-insensitively and ignoring the request port', async () => {
    const { app, introspection } = await buildApp({ allowedHosts: DECLARED });

    for (const host of ['web.plt.local', 'Web.PLT.Local', 'web.plt.local:3042']) {
      const res = await injectHost(app, introspection, host);
      expect(res.statusCode, host).toBe(200);
    }
  });

  it('never implies subdomains, and an undeclared host still answers 403 invalid_host', async () => {
    const { app, introspection } = await buildApp({ allowedHosts: DECLARED });

    for (const host of ['api.web.plt.local', 'plt.local', 'evil.example.com']) {
      const res = await injectHost(app, introspection, host);
      expect(res.statusCode, host).toBe(403);
      expect(res.json(), host).toEqual({ error: 'invalid_host' });
    }
  });

  it('host admission relaxes ONLY the Host guard: token and remote-address checks still apply', async () => {
    const { app, introspection } = await buildApp({ allowedHosts: DECLARED });

    const badToken = await app.inject({
      method: 'GET',
      url: '/__taujs/observations',
      remoteAddress: LOOPBACK,
      headers: { host: 'web.plt.local', 'x-taujs-token': 'wrong' },
    });
    expect(badToken.statusCode).toBe(403);
    expect(badToken.json()).toEqual({ error: 'invalid_token' });

    const nonLoopback = await app.inject({
      method: 'GET',
      url: '/__taujs/observations',
      remoteAddress: '192.168.1.20',
      headers: { host: 'web.plt.local', 'x-taujs-token': introspection.token },
    });
    expect(nonLoopback.statusCode).toBe(403);
    expect(nonLoopback.json()).toEqual({ error: 'loopback_only' });
  });

  it('warns ONCE per boot on an undeclared hostname - exact message, hostname as metadata - then debug', async () => {
    const { app, introspection, logger } = await buildApp({ allowedHosts: DECLARED });

    await injectHost(app, introspection, 'other.plt.local:3042');
    await injectHost(app, introspection, 'other.plt.local:3042');
    await injectHost(app, introspection, 'another.example.com');

    const rejectionWarns = logger.warn.mock.calls.filter((c: unknown[]) => String(c[1]).includes('rejected an undeclared Host'));
    expect(rejectionWarns).toHaveLength(1);
    expect(rejectionWarns[0][0]).toEqual({ component: 'introspection', host: 'other.plt.local' });
    expect(rejectionWarns[0][1]).toBe(
      'τjs introspection rejected an undeclared Host. If this is a trusted development proxy, declare it in introspection.allowedHosts.',
    );

    const rejectionDebugs = logger.debug.mock.calls.filter((c: unknown[]) => String(c[1]).includes('rejected an undeclared Host'));
    expect(rejectionDebugs).toHaveLength(2);
  });

  it('a malformed Host stays debug-only and never consumes the warn latch', async () => {
    const { app, introspection, logger } = await buildApp({ allowedHosts: DECLARED });

    const malformed = await injectHost(app, introspection, 'not a host');
    expect(malformed.statusCode).toBe(403);
    expect(malformed.json()).toEqual({ error: 'invalid_host' });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug.mock.calls.some((c: unknown[]) => String(c[1]).includes('malformed or missing Host'))).toBe(true);

    await injectHost(app, introspection, 'undeclared.example.com');
    const rejectionWarns = logger.warn.mock.calls.filter((c: unknown[]) => String(c[1]).includes('rejected an undeclared Host'));
    expect(rejectionWarns).toHaveLength(1);
    expect(rejectionWarns[0][0]).toEqual({ component: 'introspection', host: 'undeclared.example.com' });
  });
});

describe('overlay endpoint contracts', () => {
  it('GET /__taujs/graph serves a conservative schema v1 graph', async () => {
    const { app, introspection } = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/__taujs/graph', ...authed(introspection) });

    const graph = res.json();
    expect(graph.schemaVersion).toBe(1);
    expect(graph.source).toBe('boot');
    expect(graph.disclosure).toBe('conservative');
  });

  it('GET /__taujs/observations returns an empty document, never 404', async () => {
    const { app, introspection } = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/__taujs/observations', ...authed(introspection) });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ schemaVersion: 1, bootId: introspection.bootId, edges: [], shapes: [] });
  });

  it('GET /__taujs/episodes honours ?limit with a small default', async () => {
    const { app, introspection } = await buildApp();
    for (let i = 0; i < 60; i++) {
      introspection.recorder.requestStart({ requestId: `t-${i}`, url: '/x', method: 'GET' });
      introspection.recorder.sent({ requestId: `t-${i}`, status: 200, mode: 'ssr' });
    }

    const dflt = await app.inject({ method: 'GET', url: '/__taujs/episodes', ...authed(introspection) });
    expect(dflt.json().episodes).toHaveLength(50);

    const limited = await app.inject({ method: 'GET', url: '/__taujs/episodes?limit=5', ...authed(introspection) });
    expect(limited.json().episodes).toHaveLength(5);
    expect(limited.json().bootId).toBe(introspection.bootId);
  });

  it('the legacy /__taujs/traces endpoint is absent - deliberate namespace clearance (SC-09 rename migration)', async () => {
    const { app, introspection } = await buildApp();
    introspection.recorder.requestStart({ requestId: 'ns-1', url: '/x', method: 'GET' });
    introspection.recorder.sent({ requestId: 'ns-1', status: 200, mode: 'ssr' });

    // Even a correctly authenticated request finds no route at the old name...
    const legacy = await app.inject({ method: 'GET', url: '/__taujs/traces', ...authed(introspection) });
    expect(legacy.statusCode).toBe(404);

    // ...while the episode endpoint answers the same boot.
    const current = await app.inject({ method: 'GET', url: '/__taujs/episodes', ...authed(introspection) });
    expect(current.statusCode).toBe(200);
    expect(current.json().episodes).toHaveLength(1);
  });
});

describe('beacon rejection matrix (spec 03 §8 #5)', () => {
  const seedEpisode = (introspection: DevIntrospection, requestId = 'episode-ok-1') => {
    introspection.recorder.requestStart({ requestId, url: '/p', method: 'GET' });
    introspection.recorder.sent({ requestId, status: 200, mode: 'ssr' });
  };

  it('accepts a valid beacon once (204) and rejects the duplicate (409)', async () => {
    const { app, introspection, logger } = await buildApp();
    seedEpisode(introspection);

    const payload = { requestId: 'episode-ok-1', ok: true, ms: 42 };
    const first = await app.inject({ method: 'POST', url: '/__taujs/beacon', ...authed(introspection), payload });
    expect(first.statusCode).toBe(204);
    expect(first.body).toBe('');

    const dup = await app.inject({ method: 'POST', url: '/__taujs/beacon', ...authed(introspection), payload });
    expect(dup.statusCode).toBe(409);

    expect(introspection.findEpisode('episode-ok-1')!.client).toEqual({ hydrated: true, hydrationMs: 42, error: null });

    // SC-09: the beacon POST is its own Fastify request; the record names the episode it updates
    // as episodeRequestId and never claims that episode's identity as `reqId`.
    const applied = logger.debug.mock.calls.find(([, message]: [unknown, string]) => message === 'Hydration beacon applied');
    expect(applied).toBeTruthy();
    expect(applied![0]).toEqual({ component: 'introspection', episodeRequestId: 'episode-ok-1' });
    expect(applied![0]).not.toHaveProperty('reqId');
  });

  it('rejects missing token, wrong content-type, invalid requestId, and oversize bodies', async () => {
    const { app, introspection } = await buildApp();
    seedEpisode(introspection);

    const noToken = await app.inject({
      method: 'POST',
      url: '/__taujs/beacon',
      remoteAddress: LOOPBACK,
      headers: { host: 'localhost' },
      payload: { requestId: 'episode-ok-1', ok: true },
    });
    expect(noToken.statusCode).toBe(403);

    const wrongType = await app.inject({
      method: 'POST',
      url: '/__taujs/beacon',
      remoteAddress: LOOPBACK,
      headers: { host: 'localhost', 'x-taujs-token': introspection.token, 'content-type': 'text/plain' },
      body: 'requestId=episode-ok-1',
    });
    expect(wrongType.statusCode).toBe(415);

    const badEpisode = await app.inject({
      method: 'POST',
      url: '/__taujs/beacon',
      ...authed(introspection),
      payload: { requestId: 'no spaces allowed!', ok: true },
    });
    expect(badEpisode.statusCode).toBe(400);

    const oversize = await app.inject({
      method: 'POST',
      url: '/__taujs/beacon',
      ...authed(introspection),
      payload: { requestId: 'episode-ok-1', ok: true, error: 'x'.repeat(4096) },
    });
    expect(oversize.statusCode).toBe(413);

    expect(introspection.findEpisode('episode-ok-1')!.client).toBeNull();
  });

  it('drops beacons for unknown-but-valid request IDs silently (204, nothing recorded)', async () => {
    const { app, introspection } = await buildApp();

    const res = await app.inject({ method: 'POST', url: '/__taujs/beacon', ...authed(introspection), payload: { requestId: 'ghost-1', ok: true } });

    expect(res.statusCode).toBe(204);
    expect(introspection.getEpisodes()).toHaveLength(0);
  });
});

describe('dev files lifecycle (spec 03 §5)', () => {
  it('writes dev.json from the actual bound socket, mirrors rings, removes dev.json on close', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'taujs-devfiles-'));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);

    try {
      const introspection = createDevIntrospection();
      const app = fastify();
      registerDevFiles(app, introspection, mkLogger());

      introspection.recorder.requestStart({ requestId: 'file-t1', url: '/reset?token=abc&ref=x', method: 'GET' });
      introspection.recorder.sent({ requestId: 'file-t1', status: 200, mode: 'fallthrough' });

      await app.listen({ port: 0, host: '127.0.0.1' });

      // onListen hooks are not awaited by listen() — the write lands just after.
      const devJsonPath = path.join(dir, 'node_modules', '.taujs', 'dev.json');
      await vi.waitFor(async () => {
        await stat(devJsonPath);
      });
      const devJson = JSON.parse(await readFile(devJsonPath, 'utf8'));
      expect(devJson).toMatchObject({
        bootId: introspection.bootId,
        token: introspection.token,
        pid: process.pid,
        host: '127.0.0.1',
      });
      expect(devJson.port).toBeGreaterThan(0);
      expect(devJson.episodes.endsWith('episodes.ndjson')).toBe(true);

      // Ring mirror lands within a poll tick; query hygiene holds on disk (acceptance #4).
      // Wait for CONTENT, not existence: the boot reset writes the file empty at listen, so
      // existence alone no longer proves the poller has mirrored the ring.
      await vi.waitFor(async () => {
        expect(await readFile(path.join(dir, 'node_modules', '.taujs', 'episodes.ndjson'), 'utf8')).toContain('file-t1');
      });
      const ndjson = await readFile(path.join(dir, 'node_modules', '.taujs', 'episodes.ndjson'), 'utf8');

      // Assert the STRUCTURE the recorder guarantees, not the absence of a substring. The system
      // performs no value sweep: `sanitiseUrl` stores a pathname, the surviving query key names
      // and a flag, so the value never enters the buffer in the first place. A sweep across the
      // whole serialised document was a weaker proxy that also read every random identifier in
      // it - a UUID containing `abc` failed while redaction was working perfectly.
      const record = JSON.parse(
        ndjson
          .split('\n')
          .filter(Boolean)
          .find((line) => line.includes('file-t1'))!,
      );
      expect(record.url).toEqual({ pathname: '/reset', queryKeys: ['ref'], queryValuesRedacted: true });

      await app.close();
      await expect(stat(devJsonPath)).rejects.toThrow();
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('removes a stale legacy traces.ndjson at boot and exposes only episodes through dev.json (SC-09 rename migration)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'taujs-devfiles-legacy-'));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);

    try {
      const taujsDir = path.join(dir, 'node_modules', '.taujs');
      await mkdir(taujsDir, { recursive: true });
      const legacyPath = path.join(taujsDir, 'traces.ndjson');
      await writeFile(legacyPath, '{"requestId":"stale-legacy-episode"}\n');

      const introspection = createDevIntrospection();
      const app = fastify();
      registerDevFiles(app, introspection, mkLogger());

      await app.listen({ port: 0, host: '127.0.0.1' });

      const devJsonPath = path.join(taujsDir, 'dev.json');
      await vi.waitFor(async () => {
        await stat(devJsonPath);
      });
      const devJson = JSON.parse(await readFile(devJsonPath, 'utf8'));

      // A current boot exposes only the episode artefact; the legacy path never appears.
      expect(devJson.episodes.endsWith('episodes.ndjson')).toBe(true);
      expect(devJson.traces).toBeUndefined();
      // The obsolete generated file is removed explicitly, so a stale legacy artefact cannot be
      // mistaken for current-boot evidence.
      await expect(stat(legacyPath)).rejects.toThrow();

      await app.close();
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('resets the mutable ring mirrors at boot so a previous boot never serves as current (spec 03 §5 amendment, 2026-08-20)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'taujs-devfiles-reset-'));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);

    try {
      // Pre-seed all three mutable files as a dead previous boot would leave them: the poller
      // only rewrites on change, so without the boot reset an early reader would be served these.
      const taujsDir = path.join(dir, 'node_modules', '.taujs');
      await mkdir(taujsDir, { recursive: true });
      await writeFile(path.join(taujsDir, 'episodes.ndjson'), '{"requestId":"old-boot-episode"}\n');
      await writeFile(path.join(taujsDir, 'logs.ndjson'), '{"requestId":"old-boot-log"}\n');
      await writeFile(
        path.join(taujsDir, 'observations.json'),
        JSON.stringify({
          schemaVersion: 1,
          bootId: 'previous-boot',
          updatedAt: '2026-01-01T00:00:00.000Z',
          edges: [{ service: 'ghost', method: 'gone', routes: [], count: 9, lastObservedAt: '2026-01-01T00:00:00.000Z', sampleRequestIds: [] }],
          shapes: [],
        }),
      );

      const introspection = createDevIntrospection();
      const app = fastify();
      registerDevFiles(app, introspection, mkLogger());

      await app.listen({ port: 0, host: '127.0.0.1' });

      await vi.waitFor(async () => {
        const obs = JSON.parse(await readFile(path.join(taujsDir, 'observations.json'), 'utf8'));
        expect(obs.bootId).toBe(introspection.bootId);
      });
      const obs = JSON.parse(await readFile(path.join(taujsDir, 'observations.json'), 'utf8'));
      expect(obs.edges).toEqual([]);
      expect(await readFile(path.join(taujsDir, 'episodes.ndjson'), 'utf8')).toBe('');
      expect(await readFile(path.join(taujsDir, 'logs.ndjson'), 'utf8')).toBe('');

      await app.close();
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('close awaits the in-flight BOOT writes - Fastify never awaited onListen, so the timer must not start after close (CI ENOTEMPTY regression)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'taujs-devfiles-close-boot-'));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);

    try {
      const taujsDir = path.join(dir, 'node_modules', '.taujs');
      const introspection = createDevIntrospection();
      const app = fastify();
      registerDevFiles(app, introspection, mkLogger(), { pollMs: 1 });

      // Arm BEFORE listen resolves its hook work: listen() returns while onListen still runs, so
      // the FIRST boot write blocks on the gate - deterministically the fast boot-then-close shape
      // the CI tests hit, where close ran mid-boot, cleared a timer that did not exist yet, and
      // the poller then started AFTER close and wrote into a directory being removed.
      let release!: () => void;
      writeGate.held = new Promise<void>((resolve) => (release = resolve));
      writeGate.armed = true;
      await app.listen({ port: 0, host: '127.0.0.1' });
      await vi.waitFor(() => {
        expect(writeGate.heldStarts).toBeGreaterThan(0);
      });

      let closed = false;
      const closing = app.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(closed).toBe(false);

      release();
      await closing;

      // With close resolved, removal succeeds first try and nothing recreates the directory -
      // in particular the poller never started, so no 1ms tick can land afterwards.
      await rm(taujsDir, { recursive: true });
      await new Promise((resolve) => setTimeout(resolve, 25));
      await expect(stat(taujsDir)).rejects.toThrow();
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('close awaits an in-flight POLLED write via the shared flush chain (CI ENOTEMPTY regression, tick variant)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'taujs-devfiles-close-tick-'));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);

    try {
      const taujsDir = path.join(dir, 'node_modules', '.taujs');
      const introspection = createDevIntrospection();
      const app = fastify();
      registerDevFiles(app, introspection, mkLogger(), { pollMs: 1 });
      await app.listen({ port: 0, host: '127.0.0.1' });

      // Boot work completes first (dev.json on disk), so the held write below is a TICK's.
      await vi.waitFor(async () => {
        await stat(path.join(taujsDir, 'dev.json'));
      });

      // Traffic so the next tick has something to write, then arm: that write starts and BLOCKS -
      // deterministically the state the real 500ms poller reaches by chance beside close.
      introspection.recorder.requestStart({ requestId: 'race-1', url: '/race', method: 'GET' });
      introspection.recorder.sent({ requestId: 'race-1', status: 200, mode: 'fallthrough' });
      let release!: () => void;
      writeGate.held = new Promise<void>((resolve) => (release = resolve));
      const heldBefore = writeGate.heldStarts;
      writeGate.armed = true;
      await vi.waitFor(() => {
        expect(writeGate.heldStarts).toBeGreaterThan(heldBefore);
      });

      // The defect was close RESOLVING while that write was still in flight - the straggler then
      // landed during the caller's teardown and its mkdir(recursive) recreated .taujs mid-removal.
      let closed = false;
      const closing = app.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(closed).toBe(false);

      release();
      await closing;

      await rm(taujsDir, { recursive: true });
      await new Promise((resolve) => setTimeout(resolve, 25));
      await expect(stat(taujsDir)).rejects.toThrow();
    } finally {
      cwdSpy.mockRestore();
    }
  });
});
