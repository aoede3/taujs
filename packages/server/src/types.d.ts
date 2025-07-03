import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    nonce?: string;
  }
}
