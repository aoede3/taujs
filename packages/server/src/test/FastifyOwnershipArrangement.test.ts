// @vitest-environment node
//
// RFC 0010: the Fastify mechanics the host-ownership arrangement depends on.
//
// Plain Fastify only - no τjs. Every assertion here is a property of Fastify or fastify-plugin
// rather than something τjs implements, so if either changes this file fails before the product
// suite does and names the reason.

import { createRequire } from 'node:module';

import fastify from 'fastify';
import fp from 'fastify-plugin';
import { describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

const require = createRequire(import.meta.url);
const FASTIFY_BASELINE = '5.10.0';
const FASTIFY_PLUGIN_BASELINE = '5.1.0';
const SKIP_OVERRIDE = Symbol.for('skip-override');
const REGISTERED_PLUGINS = Symbol.for('registered-plugin');
const PLUGIN_NAME = 'rfc0010-owned-scope';

type Branded = Record<symbol, unknown>;

/** The shipped arrangement: one body, and the ownership fact drives Fastify's own encapsulation switch. */
const ownedScopePlugin = ({ callerOwnedHost }: { callerOwnedHost: boolean }) =>
  fp(
    async (scope: FastifyInstance) => {
      scope.decorate('ownedMark', callerOwnedHost ? 'embedded' : 'created');
      scope.decorateRequest('ownedCtx', null);
      scope.addHook('onRequest', async (request) => {
        (request as never as { ownedCtx?: string }).ownedCtx = 'owned';
      });
      scope.setErrorHandler(async (error: Error, _request, reply) => reply.status(500).send({ owner: 'owned', message: error.message }));
      scope.get('/owned-page', async (request) => ({ owner: 'owned', ctx: (request as never as { ownedCtx?: string }).ownedCtx }));
      scope.get('/owned-boom', async () => {
        throw new Error('owned-boom');
      });
    },
    { name: PLUGIN_NAME, encapsulate: callerOwnedHost },
  );

const closing = async <T>(app: FastifyInstance, run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } finally {
    await app.close();
  }
};

describe('RFC 0010 - Fastify ownership arrangement', () => {
  it('pins the Fastify and fastify-plugin versions this arrangement was measured against', () => {
    expect((require('fastify/package.json') as { version: string }).version).toBe(FASTIFY_BASELINE);
    // `encapsulate` is a fastify-plugin v5 option and the whole design rests on it.
    expect((require('fastify-plugin/package.json') as { version: string }).version).toBe(FASTIFY_PLUGIN_BASELINE);
  });

  it('fp() brands the function it is given, which is why no bare-function variant exists', async () => {
    const installer = async (scope: FastifyInstance) => {
      scope.decorate('sharedMark', true);
    };

    expect((installer as never as Branded)[SKIP_OVERRIDE]).toBeUndefined();

    const wrapped = fp(installer, { name: 'rfc0010-shared-installer' });

    // fastify-plugin mutates its input and returns that same reference, so registering the "raw"
    // object afterwards silently stops encapsulating. The shipped arrangement avoids the shape
    // entirely by wrapping in both modes and varying `encapsulate`.
    expect((installer as never as Branded)[SKIP_OVERRIDE]).toBe(true);
    expect(wrapped).toBe(installer);

    const leaked = fastify({ logger: false });
    await closing(leaked, async () => {
      await leaked.register(installer);
      await leaked.ready();
      expect(Object.prototype.hasOwnProperty.call(leaked, 'sharedMark')).toBe(true);
    });
  });

  it('encapsulate: true isolates hooks, decorators and the error handler from the caller root', async () => {
    const app = fastify({ logger: false });

    app.decorate('authenticate', async () => undefined);
    app.setErrorHandler(async (error: Error, _request, reply) => reply.status(599).send({ owner: 'caller', message: error.message }));
    app.setNotFoundHandler(async (_request, reply) => reply.status(404).send({ owner: 'caller-not-found' }));
    app.get('/host-before', async (request) => ({ owner: 'caller', ctx: (request as never as { ownedCtx?: string }).ownedCtx ?? 'none' }));
    app.get('/host-before-error', async () => {
      throw new Error('caller-before-boom');
    });

    await app.register(ownedScopePlugin({ callerOwnedHost: true }));

    app.get('/host-after', async (request) => ({ owner: 'caller', ctx: (request as never as { ownedCtx?: string }).ownedCtx ?? 'none' }));
    app.get('/host-after-error', async () => {
      throw new Error('caller-after-boom');
    });

    await closing(app, async () => {
      await app.ready();

      // Caller routes keep their own everything, declared before or after registration.
      for (const url of ['/host-before', '/host-after']) {
        expect(JSON.parse((await app.inject(url)).body)).toEqual({ owner: 'caller', ctx: 'none' });
      }
      for (const url of ['/host-before-error', '/host-after-error']) {
        const response = await app.inject(url);
        expect(response.statusCode).toBe(599);
        expect(JSON.parse(response.body).owner).toBe('caller');
      }
      expect(JSON.parse((await app.inject('/nope')).body)).toEqual({ owner: 'caller-not-found' });

      // The owned scope keeps its own lifecycle.
      expect(JSON.parse((await app.inject('/owned-page')).body)).toEqual({ owner: 'owned', ctx: 'owned' });
      const ownedError = await app.inject('/owned-boom');
      expect(ownedError.statusCode).toBe(500);
      expect(JSON.parse(ownedError.body).owner).toBe('owned');

      // Decorations stay in the child, but the plugin is still named in the host's tree: registration
      // is visible, policy is not.
      expect('ownedMark' in app).toBe(false);
      expect((app as never as Record<symbol, string[]>)[REGISTERED_PLUGINS]).toContain(PLUGIN_NAME);
      expect(app.printPlugins()).toContain(PLUGIN_NAME);
    });
  });

  it('the encapsulated child inherits caller decorators, so auth delegation still works', async () => {
    const app = fastify({ logger: false });
    app.decorate('authenticate', async () => undefined);
    app.decorate('callerThing', 'from-caller');

    await app.register(
      fp(
        async (scope: FastifyInstance) => {
          scope.get('/probe', async () => ({
            authenticate: typeof (scope as never as { authenticate?: unknown }).authenticate,
            callerThing: (scope as never as { callerThing?: string }).callerThing,
          }));
        },
        { name: 'rfc0010-inheritance-probe', encapsulate: true },
      ),
    );

    await closing(app, async () => {
      await app.ready();
      expect(JSON.parse((await app.inject('/probe')).body)).toEqual({ authenticate: 'function', callerThing: 'from-caller' });
    });
  });

  it('encapsulate: false installs at the owned root, giving the created-host experience', async () => {
    const app = fastify({ logger: false });

    // A route captures the error handler present when it is registered, so anything declared before
    // the installer keeps Fastify's default. Unreachable for a τjs-created host, which constructs
    // the instance and registers immediately, but pinned so the ordering property is documented.
    app.get('/root-before', async () => {
      throw new Error('root-before-boom');
    });

    await app.register(ownedScopePlugin({ callerOwnedHost: false }));

    // A created host hands `app` back after createServer resolves, so real caller routes land here
    // and inherit the owned handler. That is the complete experience.
    app.get('/root-after', async () => {
      throw new Error('root-after-boom');
    });

    await closing(app, async () => {
      await app.ready();

      expect(JSON.parse((await app.inject('/owned-page')).body)).toEqual({ owner: 'owned', ctx: 'owned' });

      const afterError = await app.inject('/root-after');
      expect(afterError.statusCode).toBe(500);
      expect(JSON.parse(afterError.body).owner).toBe('owned');

      const beforeError = await app.inject('/root-before');
      expect(beforeError.statusCode).toBe(500);
      expect(JSON.parse(beforeError.body).owner).toBeUndefined();

      expect('ownedMark' in app).toBe(true);
      expect(app.printPlugins()).toContain(PLUGIN_NAME);
    });
  });

  it('a scoped error handler boots under allowErrorHandlerOverride: false and covers every route in its scope', async () => {
    const app = fastify({ allowErrorHandlerOverride: false, logger: false });

    app.setErrorHandler(async (error: Error, _request, reply) => reply.status(599).send({ owner: 'caller', message: error.message }));

    await expect(
      app.register(
        fp(
          async (scope: FastifyInstance) => {
            scope.setErrorHandler(async (error: Error, _request, reply) => reply.status(500).send({ owner: 'owned', message: error.message }));
            // Stands in for the τjs facilities sharing the owned scope: pages, static, CSP report,
            // introspection. All must inherit the scoped handler, not the caller's.
            scope.get('/owned-page', async () => {
              throw new Error('page-boom');
            });
            await scope.register(async (nested) => {
              nested.get('/owned-facility', async () => {
                throw new Error('facility-boom');
              });
            });
          },
          { name: 'rfc0010-strict-scope', encapsulate: true },
        ),
      ),
    ).resolves.not.toThrow();

    await closing(app, async () => {
      await app.ready();

      for (const url of ['/owned-page', '/owned-facility']) {
        const response = await app.inject(url);
        expect(response.statusCode).toBe(500);
        expect(JSON.parse(response.body).owner).toBe('owned');
      }
    });
  });

  it('not-found handlers are keyed by prefix, so an unprefixed child cannot own one safely', async () => {
    // With a caller handler present, registering one in the child is a hard boot failure.
    const collides = fastify({ logger: false });
    collides.setNotFoundHandler(async (_request, reply) => reply.status(404).send({ owner: 'caller-not-found' }));

    await expect(
      collides.register(
        fp(
          async (scope: FastifyInstance) => {
            scope.setNotFoundHandler(async (_request, reply) => reply.status(404).send({ owner: 'owned-not-found' }));
          },
          { name: 'rfc0010-notfound-collision', encapsulate: true },
        ),
      ),
    ).rejects.toThrow("Not found handler already set for Fastify instance with prefix: '/'");
    await collides.close();

    // With no caller handler, the child silently becomes the not-found owner for the whole server.
    // This is why the installer registers one only in created mode.
    const captures = fastify({ logger: false });
    await captures.register(
      fp(
        async (scope: FastifyInstance) => {
          scope.setNotFoundHandler(async (_request, reply) => reply.status(404).send({ owner: 'owned-not-found' }));
        },
        { name: 'rfc0010-notfound-capture', encapsulate: true },
      ),
    );

    await closing(captures, async () => {
      await captures.ready();
      expect(JSON.parse((await captures.inject('/anything')).body)).toEqual({ owner: 'owned-not-found' });
    });
  });

  it('only a root-level onRequest hook observes URLs Fastify did not route', async () => {
    const app = fastify({ logger: false });
    const rootSaw: string[] = [];
    const childSaw: string[] = [];

    app.addHook('onRequest', async (request) => {
      rootSaw.push(request.url);
    });
    await app.register(
      fp(
        async (scope: FastifyInstance) => {
          scope.addHook('onRequest', async (request) => {
            childSaw.push(request.url);
          });
          scope.get('/owned-page', async () => ({ owner: 'owned' }));
        },
        { name: 'rfc0010-unrouted-probe', encapsulate: true },
      ),
    );

    await closing(app, async () => {
      await app.ready();
      await app.inject('/owned-page');
      await app.inject('/@vite/client');

      // The whole reason `viteRequestHookOwner` exists: Vite must see unrouted development URLs,
      // and an encapsulated hook never will.
      expect(rootSaw).toEqual(['/owned-page', '/@vite/client']);
      expect(childSaw).toEqual(['/owned-page']);
    });
  });
});
