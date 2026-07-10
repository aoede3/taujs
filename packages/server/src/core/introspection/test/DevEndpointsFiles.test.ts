// @vitest-environment node
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import fastify from 'fastify';
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const buildApp = async (opts?: { taujsConfig?: CoreTaujsConfig; introspection?: DevIntrospection }) => {
  const introspection = opts?.introspection ?? createDevIntrospection();
  const app = fastify();
  registerIntrospectionEndpoints(app, { introspection, taujsConfig: opts?.taujsConfig ?? config, logger: mkLogger() });
  return { app, introspection };
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

  it('GET /__taujs/traces honours ?limit with a small default', async () => {
    const { app, introspection } = await buildApp();
    for (let i = 0; i < 60; i++) {
      introspection.recorder.requestStart({ traceId: `t-${i}`, url: '/x', method: 'GET' });
      introspection.recorder.sent({ traceId: `t-${i}`, status: 200, mode: 'ssr' });
    }

    const dflt = await app.inject({ method: 'GET', url: '/__taujs/traces', ...authed(introspection) });
    expect(dflt.json().traces).toHaveLength(50);

    const limited = await app.inject({ method: 'GET', url: '/__taujs/traces?limit=5', ...authed(introspection) });
    expect(limited.json().traces).toHaveLength(5);
    expect(limited.json().bootId).toBe(introspection.bootId);
  });
});

describe('beacon rejection matrix (spec 03 §8 #5)', () => {
  const seedTrace = (introspection: DevIntrospection, traceId = 'trace-ok-1') => {
    introspection.recorder.requestStart({ traceId, url: '/p', method: 'GET' });
    introspection.recorder.sent({ traceId, status: 200, mode: 'ssr' });
  };

  it('accepts a valid beacon once (204) and rejects the duplicate (409)', async () => {
    const { app, introspection } = await buildApp();
    seedTrace(introspection);

    const payload = { traceId: 'trace-ok-1', ok: true, ms: 42 };
    const first = await app.inject({ method: 'POST', url: '/__taujs/beacon', ...authed(introspection), payload });
    expect(first.statusCode).toBe(204);
    expect(first.body).toBe('');

    const dup = await app.inject({ method: 'POST', url: '/__taujs/beacon', ...authed(introspection), payload });
    expect(dup.statusCode).toBe(409);

    expect(introspection.findTrace('trace-ok-1')!.client).toEqual({ hydrated: true, hydrationMs: 42, error: null });
  });

  it('rejects missing token, wrong content-type, invalid traceId, and oversize bodies', async () => {
    const { app, introspection } = await buildApp();
    seedTrace(introspection);

    const noToken = await app.inject({
      method: 'POST',
      url: '/__taujs/beacon',
      remoteAddress: LOOPBACK,
      headers: { host: 'localhost' },
      payload: { traceId: 'trace-ok-1', ok: true },
    });
    expect(noToken.statusCode).toBe(403);

    const wrongType = await app.inject({
      method: 'POST',
      url: '/__taujs/beacon',
      remoteAddress: LOOPBACK,
      headers: { host: 'localhost', 'x-taujs-token': introspection.token, 'content-type': 'text/plain' },
      body: 'traceId=trace-ok-1',
    });
    expect(wrongType.statusCode).toBe(415);

    const badTrace = await app.inject({
      method: 'POST',
      url: '/__taujs/beacon',
      ...authed(introspection),
      payload: { traceId: 'no spaces allowed!', ok: true },
    });
    expect(badTrace.statusCode).toBe(400);

    const oversize = await app.inject({
      method: 'POST',
      url: '/__taujs/beacon',
      ...authed(introspection),
      payload: { traceId: 'trace-ok-1', ok: true, error: 'x'.repeat(4096) },
    });
    expect(oversize.statusCode).toBe(413);

    expect(introspection.findTrace('trace-ok-1')!.client).toBeNull();
  });

  it('drops beacons for unknown-but-valid traceIds silently (204, nothing recorded)', async () => {
    const { app, introspection } = await buildApp();

    const res = await app.inject({ method: 'POST', url: '/__taujs/beacon', ...authed(introspection), payload: { traceId: 'ghost-1', ok: true } });

    expect(res.statusCode).toBe(204);
    expect(introspection.getTraces()).toHaveLength(0);
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

      introspection.recorder.requestStart({ traceId: 'file-t1', url: '/reset?token=abc&ref=x', method: 'GET' });
      introspection.recorder.sent({ traceId: 'file-t1', status: 200, mode: 'fallthrough' });

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
      expect(devJson.traces.endsWith('traces.ndjson')).toBe(true);

      // Ring mirror lands within a poll tick; query hygiene holds on disk (acceptance #4).
      await vi.waitFor(async () => {
        await stat(path.join(dir, 'node_modules', '.taujs', 'traces.ndjson'));
      });
      const ndjson = await readFile(path.join(dir, 'node_modules', '.taujs', 'traces.ndjson'), 'utf8');
      expect(ndjson).toContain('"pathname":"/reset"');
      expect(ndjson).toContain('"queryKeys":["ref"]');
      expect(ndjson).not.toContain('abc');
      expect(ndjson).not.toContain('token=');

      await app.close();
      await expect(stat(devJsonPath)).rejects.toThrow();
    } finally {
      cwdSpy.mockRestore();
    }
  });
});
