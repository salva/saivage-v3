import type { FastifyRequest } from 'fastify';

export function serializeRequestForLog(request: FastifyRequest): {
  method: string;
  url: string;
  version: string | undefined;
  host: string;
  remoteAddress: string;
  remotePort: number | undefined;
} {
  const queryStart = request.url.indexOf('?');
  return {
    method: request.method,
    url: queryStart === -1 ? request.url : request.url.slice(0, queryStart),
    version: request.headers['accept-version'] as string | undefined,
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket.remotePort,
  };
}
