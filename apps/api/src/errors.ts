import type { FastifyInstance } from 'fastify';

/** An error whose message is safe to show to the client. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'TOO_MANY_REQUESTS',
  503: 'SERVICE_UNAVAILABLE',
};

/** Every error leaves as `{ error: { code, message } }` (docs/04-api.md). No stack traces. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, request, reply) => {
    const raw =
      typeof err === 'object' && err !== null && 'statusCode' in err ? Number(err.statusCode) : 500;
    const status = raw >= 400 && raw < 600 ? raw : 500;
    const isServerError = status >= 500 && !(err instanceof HttpError);
    if (isServerError) request.log.error({ err }, 'request failed');

    const code = err instanceof HttpError ? err.code : (CODES[status] ?? 'INTERNAL');
    const message = isServerError
      ? 'Internal server error'
      : err instanceof Error
        ? err.message
        : 'Request failed';
    return reply.status(status).send({ error: { code, message } });
  });
}
