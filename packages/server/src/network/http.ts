import type { FastifyRequest } from 'fastify';

export function requestPathname(req: FastifyRequest): string {
  const u = req.url || req.raw?.url || '/';
  const q = u.indexOf('?');
  return q === -1 ? u : u.slice(0, q);
}
