import 'fastify';

import type { DevIntrospection } from './core/introspection/DevIntrospection';
import type { RequestContext } from './core/telemetry/Telemetry';

declare module 'fastify' {
  interface FastifyRequest {
    cspNonce?: string;
    /** Per-request trace context, set by SSRServer's onRequest hook (trace before auth). */
    taujsRequestContext?: RequestContext | null;
    routeMeta?: {
      path?: string;
      appId?: string;
      attr?: {
        middleware?: {
          auth?: {
            strategy?: string;
            roles?: string[];
            redirect?: string;
          };
        };
        render?: string;
      };
    };
  }

  interface FastifyInstance {
    /**
     * Optional authentication hook to be used by the taujs SSRServer.
     * This method must be decorated by the user when using auth middleware in `taujs.config.ts`.
     *
     * Example usage:
     * ```ts
     * fastify.decorate('authenticate', async function (req, reply) {
     *   await req.jwtVerify();
     * });
     * ```
     */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    showBanner(): void;
    cspNonce?: string;
    /** Dev-only introspection state (recorder, buffers, token); absent in production. */
    taujsIntrospection?: DevIntrospection;
  }
}
