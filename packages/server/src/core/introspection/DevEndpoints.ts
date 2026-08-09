import { isIP } from 'node:net';

import { REGEX } from '../constants';
import { createRequestGraph } from './RequestGraph';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CoreTaujsConfig } from '../config/types';
import type { Logs } from '../logging/types';
import type { ServiceRegistry } from '../services/DataServices';
import type { DevIntrospection } from './DevIntrospection';

const SSE_POLL_MS = 500;
const EPISODES_DEFAULT_LIMIT = 50;
const BEACON_BODY_LIMIT = 2048;
const BEACON_ERROR_CAP = 500;

const isLoopback = (address: string | undefined): boolean => !!address && (address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.'));

// Host validation neutralises DNS rebinding: an attack needs a DNS *name* resolving to the
// dev machine, so names other than localhost are rejected while IP-literal hosts (the
// phone-on-LAN case behind allowNonLoopback) pass — an IP literal cannot be rebound.
//
// Post-freeze ruling 2026-08-08: declared admissions (`introspection.allowedHosts`, resolved
// and validated at createServer entry) EXTEND the intrinsic set for development behind a
// Host-rewriting proxy. Exact matching preserves the direct-listener rebinding guard; behind
// such a proxy τjs sees only the declared upstream name, so browser-facing host admission is
// DELEGATED to the proxy — τjs reads no forwarding headers.
const parseHostname = (hostHeader: string | undefined): string | undefined => {
  if (!hostHeader) return undefined;

  try {
    // URL parsing case-folds the hostname and drops the port, so the declared lowercase set
    // compares against a canonical form without any per-site handling here.
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return undefined;
  }
};

const isAllowedHost = (hostname: string, allowedHosts: ReadonlySet<string>): boolean => {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  return bare === 'localhost' || bare.endsWith('.localhost') || isIP(bare) !== 0 || allowedHosts.has(bare);
};

export type IntrospectionEndpointsOptions = {
  introspection: DevIntrospection;
  serviceRegistry?: ServiceRegistry;
  taujsConfig?: CoreTaujsConfig;
  /**
   * Resolved lowercase exact-match host admissions (post-freeze ruling 2026-08-08), validated
   * at `createServer` entry and never re-derived here. Intrinsic admissions always apply.
   */
  allowedHosts?: ReadonlySet<string>;
  logger: Logs;
};

// Overlay-only endpoints (spec 03 §6), registered exclusively from the structural dev gate.
// Guard order on every endpoint: loopback remote-address (unless allowNonLoopback) →
// Host validation → per-boot token. When gating conditions don't hold these routes are
// simply never registered — absence, not a "disabled" response.
export const registerIntrospectionEndpoints = (app: FastifyInstance, options: IntrospectionEndpointsOptions): void => {
  const { introspection, taujsConfig, serviceRegistry, logger } = options;
  const allowNonLoopback = taujsConfig?.introspection?.allowNonLoopback === true;
  const allowedHosts = options.allowedHosts ?? new Set<string>();

  // The measured failure mode (RFC 0012 leg D2) is a proxied development topology whose
  // beacons die silently, so the FIRST undeclared-hostname refusal warns; repeats log at
  // debug (one boolean latch per boot - flood-safe by construction). The hostname is
  // attacker-influenced text, so it travels as structured metadata, never interpolated into
  // the message. Malformed or missing Host values stay debug-only and never consume the latch.
  let undeclaredHostWarned = false;

  const guard = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    if (!allowNonLoopback && !isLoopback(req.socket.remoteAddress)) return reply.code(403).send({ error: 'loopback_only' });

    const hostname = parseHostname(req.headers.host);

    if (hostname === undefined) {
      logger.debug?.({ component: 'introspection' }, 'τjs introspection rejected a malformed or missing Host');
      return reply.code(403).send({ error: 'invalid_host' });
    }

    if (!isAllowedHost(hostname, allowedHosts)) {
      if (!undeclaredHostWarned) {
        undeclaredHostWarned = true;
        logger.warn(
          { component: 'introspection', host: hostname },
          'τjs introspection rejected an undeclared Host. If this is a trusted development proxy, declare it in introspection.allowedHosts.',
        );
      } else {
        logger.debug?.({ component: 'introspection', host: hostname }, 'τjs introspection rejected an undeclared Host');
      }
      return reply.code(403).send({ error: 'invalid_host' });
    }

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

  app.get('/__taujs/episodes', { preHandler: guard }, async (req, reply) => {
    const accept = String(req.headers.accept ?? '');

    if (accept.includes('text/event-stream')) {
      // Consumed via fetch() + ReadableStream so the token travels as a header (RFC Q2).
      //
      // The LAST `reply.hijack()` in the codebase, intentionally out of scope for the streaming
      // transport change rather than inherent to SSE: Fastify can own an SSE response through a
      // Readable, which would compose with hooks, backpressure, disconnect handling and the normal
      // response headers (including `x-request-id`) exactly as application streaming now does.
      // Assessing that needs SSE-specific evidence - immediate header flush, event delivery,
      // disconnect cleanup, backpressure, request identity, hooks and shutdown - so it is left
      // alone here rather than changed without it.
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      const seen = new Set<string>();
      const push = () => {
        for (const episode of introspection.getEpisodes()) {
          if (seen.has(episode.requestId)) continue;
          seen.add(episode.requestId);
          reply.raw.write(`data: ${JSON.stringify(episode)}\n\n`);
        }
      };

      push();
      const timer = setInterval(push, SSE_POLL_MS);
      timer.unref?.();
      req.raw.on('close', () => clearInterval(timer));
      return;
    }

    const rawLimit = Number((req.query as Record<string, unknown>)?.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : EPISODES_DEFAULT_LIMIT;

    return reply.send({ bootId: introspection.bootId, episodes: introspection.getEpisodes(limit) });
  });

  // The one write endpoint (RFC security model §3). Registered here; the client-side stamp
  // and emitter are P0B-04. Never reflects submitted content.
  app.post('/__taujs/beacon', { preHandler: guard, bodyLimit: BEACON_BODY_LIMIT }, async (req, reply) => {
    // Content-Type is a guard, not a formality: forcing application/json pushes cross-origin
    // attempts into CORS-preflight territory (RFC security model §3).
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) return reply.code(415).send({ error: 'invalid_content_type' });

    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return reply.code(400).send({ error: 'invalid_body' });

    const { requestId, ok, ms, error } = body;
    if (typeof requestId !== 'string' || !REGEX.SAFE_REQUEST_ID.test(requestId)) return reply.code(400).send({ error: 'invalid_request_id' });
    if (typeof ok !== 'boolean') return reply.code(400).send({ error: 'invalid_body' });
    if (ms !== undefined && typeof ms !== 'number') return reply.code(400).send({ error: 'invalid_body' });
    if (error !== undefined && typeof error !== 'string') return reply.code(400).send({ error: 'invalid_body' });

    const episode = introspection.findEpisode(requestId);
    if (!episode) return reply.code(204).send(); // unknown or evicted: dropped silently
    if (episode.client) return reply.code(409).send({ error: 'duplicate_beacon' });

    introspection.recorder.clientHydration({ requestId, ok, ms, error: typeof error === 'string' ? error.slice(0, BEACON_ERROR_CAP) : undefined });
    // SC-09: `reqId` means the current Fastify request - here that is the beacon POST, not the
    // page episode this beacon updates. The updated episode is named explicitly instead.
    logger.debug?.({ component: 'introspection', episodeRequestId: requestId }, 'Hydration beacon applied');

    return reply.code(204).send();
  });
};
