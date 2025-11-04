import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    cspNonce?: string;
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
  }
}
