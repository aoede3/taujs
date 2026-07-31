// @vitest-environment node
// RFC 0007 (R5): dev-episode retention of the per-key deferred outcome, and its DURABLE arrival in
// the on-disk NDJSON through the ordinary bounded persistence mechanism.
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import fastify from 'fastify';
import { describe, it, expect, vi } from 'vitest';

import { createDevIntrospection } from '../DevIntrospection';
import { registerDevFiles } from '../DevFiles';

const mkLogger = (): any => {
  const l: any = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), isDebugEnabled: () => false };
  l.child = () => l;
  return l;
};

describe('dev episode retention of deferred outcomes (RFC 0007 R5)', () => {
  it('retains { key, outcome, ms } per key and stays ABSENT for a episode with no deferred events', () => {
    const dev = createDevIntrospection();

    dev.recorder.requestStart({ requestId: 'plain', url: '/plain', method: 'GET' });
    dev.recorder.sent({ requestId: 'plain', status: 200, mode: 'streaming' });

    dev.recorder.requestStart({ requestId: 'deferred', url: '/product/42', method: 'GET' });
    dev.recorder.deferredData({ requestId: 'deferred', key: 'reviews', ms: 12.5, outcome: 'complete' });
    dev.recorder.deferredData({ requestId: 'deferred', key: 'stock', ms: 30, outcome: 'failed' });
    dev.recorder.sent({ requestId: 'deferred', status: 200, mode: 'streaming' });

    const episodes = Object.fromEntries(dev.getEpisodes().map((t) => [t.requestId, t]));
    expect('deferredData' in episodes['plain']!).toBe(false);
    expect(episodes['deferred']!.deferredData).toEqual([
      { key: 'reviews', outcome: 'complete', ms: 12.5 },
      { key: 'stock', outcome: 'failed', ms: 30 },
    ]);
    // No payload, params, message or stack ever crosses.
    expect(JSON.stringify(episodes['deferred']!.deferredData)).toBe(
      '[{"key":"reviews","outcome":"complete","ms":12.5},{"key":"stock","outcome":"failed","ms":30}]',
    );
  });

  it('resolves FINALISED episodes too - the client-disconnect ordering R5 exists to explain', () => {
    const dev = createDevIntrospection();

    dev.recorder.requestStart({ requestId: 'disconnect', url: '/product/42', method: 'GET' });
    // The host records the benign abort (finalising the episode) BEFORE the abort reaches the registry.
    dev.recorder.aborted({ requestId: 'disconnect', phase: 'stream' });
    dev.recorder.deferredData({ requestId: 'disconnect', key: 'reviews', ms: 4, outcome: 'aborted' });

    expect(dev.findEpisode('disconnect')!.deferredData).toEqual([{ key: 'reviews', outcome: 'aborted', ms: 4 }]);
  });

  it('a late outcome marks the persisted episode DIRTY: episodesRevision advances without a new episode', () => {
    const dev = createDevIntrospection();

    dev.recorder.requestStart({ requestId: 'late', url: '/product/42', method: 'GET' });
    dev.recorder.sent({ requestId: 'late', status: 200, mode: 'streaming' });
    const afterFinalize = dev.stats();

    dev.recorder.deferredData({ requestId: 'late', key: 'reviews', ms: 9, outcome: 'aborted' });
    const afterLate = dev.stats();

    expect(afterLate.episodes).toBe(afterFinalize.episodes);
    expect(afterLate.episodesRevision).toBe(afterFinalize.episodesRevision + 1);
  });

  it('a late outcome reaches the on-disk episodes.ndjson through the ordinary bounded rewrite', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'taujs-deferred-'));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      const dev = createDevIntrospection();
      const app = fastify();
      registerDevFiles(app, dev, mkLogger());

      dev.recorder.requestStart({ requestId: 'late-disk', url: '/product/42', method: 'GET' });
      dev.recorder.sent({ requestId: 'late-disk', status: 200, mode: 'streaming' });

      await app.listen({ port: 0, host: '127.0.0.1' });

      const episodesPath = path.join(dir, 'node_modules', '.taujs', 'episodes.ndjson');
      await vi.waitFor(async () => {
        await stat(episodesPath);
        expect(await readFile(episodesPath, 'utf8')).toContain('late-disk');
      });
      expect(await readFile(episodesPath, 'utf8')).not.toContain('deferredData');

      // The outcome arrives AFTER the episode was finalised and persisted.
      dev.recorder.deferredData({ requestId: 'late-disk', key: 'reviews', ms: 7, outcome: 'aborted' });

      await vi.waitFor(async () => {
        expect(await readFile(episodesPath, 'utf8')).toContain('"deferredData":[{"key":"reviews","outcome":"aborted","ms":7}]');
      });

      await app.close();
    } finally {
      cwdSpy.mockRestore();
    }
  });
});
