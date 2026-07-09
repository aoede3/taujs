import { isIP } from 'node:net';

import { REGEX } from '../constants';
import { createRequestGraph } from './RequestGraph';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CoreTaujsConfig } from '../config/types';
import type { Logs } from '../logging/types';
import type { ServiceRegistry } from '../services/DataServices';
import type { DevIntrospection } from './DevIntrospection';

const SSE_POLL_MS = 500;
const TRACES_DEFAULT_LIMIT = 50;
const BEACON_BODY_LIMIT = 2048;
const BEACON_ERROR_CAP = 500;

const isLoopback = (address: string | undefined): boolean => !!address && (address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.'));

// Host validation neutralises DNS rebinding: an attack needs a DNS *name* resolving to the
// dev machine, so names other than localhost are rejected while IP-literal hosts (the
// phone-on-LAN case behind allowNonLoopback) pass — an IP literal cannot be rebound.
const isAllowedHost = (hostHeader: string | undefined): boolean => {
  if (!hostHeader) return false;

  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname;
  } catch {
    return false;
  }

  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  return bare === 'localhost' || bare.endsWith('.localhost') || isIP(bare) !== 0;
};

export type IntrospectionEndpointsOptions = {
  introspection: DevIntrospection;
  serviceRegistry?: ServiceRegistry;
  taujsConfig?: CoreTaujsConfig;
  logger: Logs;
};

// Overlay-only endpoints (spec 03 §6), registered exclusively from the structural dev gate.
// Guard order on every endpoint: loopback remote-address (unless allowNonLoopback) →
// Host validation → per-boot token. When gating conditions don't hold these routes are
// simply never registered — absence, not a "disabled" response.
export const registerIntrospectionEndpoints = (app: FastifyInstance, options: IntrospectionEndpointsOptions): void => {
  const { introspection, taujsConfig, serviceRegistry, logger } = options;
  const allowNonLoopback = taujsConfig?.introspection?.allowNonLoopback === true;

  const guard = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    if (!allowNonLoopback && !isLoopback(req.socket.remoteAddress)) return reply.code(403).send({ error: 'loopback_only' });
    if (!isAllowedHost(req.headers.host)) return reply.code(403).send({ error: 'invalid_host' });
    if (req.headers['x-taujs-token'] !== introspection.token) return reply.code(403).send({ error: 'invalid_token' });
    return undefined;
  };

  app.get('/__taujs/graph', { preHandler: guard }, async (_req, reply) => {
    if (!taujsConfig) return reply.code(503).send({ error: 'graph_unavailable' });

    // Live overlay tier. Spec 02 permits richer disclosure here (MAY); v1 serves the
    // conservative document — richer tiers arrive with the DevTools overlay (Phase 2).
    const graph = createRequestGraph(taujsConfig, { source: 'boot', emittedAt: new Date().toISOString(), serviceRegistry });
    return reply.send(graph);
  });

  app.get('/__taujs/observations', { preHandler: guard }, async (_req, reply) => {
    // Empty document (never 404) when nothing observed yet.
    return reply.send(introspection.getObservations());
  });

  app.get('/__taujs/traces', { preHandler: guard }, async (req, reply) => {
    const accept = String(req.headers.accept ?? '');

    if (accept.includes('text/event-stream')) {
      // Consumed via fetch() + ReadableStream so the token travels as a header (RFC Q2).
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      const seen = new Set<string>();
      const push = () => {
        for (const trace of introspection.getTraces()) {
          if (seen.has(trace.traceId)) continue;
          seen.add(trace.traceId);
          reply.raw.write(`data: ${JSON.stringify(trace)}\n\n`);
        }
      };

      push();
      const timer = setInterval(push, SSE_POLL_MS);
      timer.unref?.();
      req.raw.on('close', () => clearInterval(timer));
      return;
    }

    const rawLimit = Number((req.query as Record<string, unknown>)?.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : TRACES_DEFAULT_LIMIT;

    return reply.send({ bootId: introspection.bootId, traces: introspection.getTraces(limit) });
  });

  // The one write endpoint (RFC security model §3). Registered here; the client-side stamp
  // and emitter are P0B-04. Never reflects submitted content.
  app.post('/__taujs/beacon', { preHandler: guard, bodyLimit: BEACON_BODY_LIMIT }, async (req, reply) => {
    // Content-Type is a guard, not a formality: forcing application/json pushes cross-origin
    // attempts into CORS-preflight territory (RFC security model §3).
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) return reply.code(415).send({ error: 'invalid_content_type' });

    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return reply.code(400).send({ error: 'invalid_body' });

    const { traceId, ok, ms, error } = body;
    if (typeof traceId !== 'string' || !REGEX.SAFE_TRACE.test(traceId)) return reply.code(400).send({ error: 'invalid_trace_id' });
    if (typeof ok !== 'boolean') return reply.code(400).send({ error: 'invalid_body' });
    if (ms !== undefined && typeof ms !== 'number') return reply.code(400).send({ error: 'invalid_body' });
    if (error !== undefined && typeof error !== 'string') return reply.code(400).send({ error: 'invalid_body' });

    const trace = introspection.findTrace(traceId);
    if (!trace) return reply.code(204).send(); // unknown or evicted: dropped silently
    if (trace.client) return reply.code(409).send({ error: 'duplicate_beacon' });

    introspection.recorder.clientHydration({ traceId, ok, ms, error: typeof error === 'string' ? error.slice(0, BEACON_ERROR_CAP) : undefined });
    logger.debug?.({ component: 'introspection', traceId }, 'Hydration beacon applied');

    return reply.code(204).send();
  });
};
