import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError, toAppError } from '../../app/errors.js';

const TITLES: Record<number, string> = {
  400: 'Solicitud inválida',
  401: 'No autenticado',
  403: 'Prohibido',
  404: 'No encontrado',
  409: 'Conflicto',
  413: 'Contenido demasiado grande',
  422: 'Jugada no permitida',
  429: 'Demasiadas solicitudes',
  500: 'Error interno',
};

/** Serializa cualquier error como RFC 9457 Problem Details (application/problem+json). */
export function problemHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply): void {
  let appErr: AppError;
  if (err instanceof ZodError) {
    appErr = new AppError(400, 'VALIDATION_FAILED', 'La solicitud no cumple el esquema', {
      errors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  } else if ('statusCode' in err && err.statusCode === 429) {
    appErr = new AppError(429, 'RATE_LIMITED', 'Límite de solicitudes excedido');
  } else if ('statusCode' in err && err.statusCode === 413) {
    appErr = new AppError(413, 'PAYLOAD_TOO_LARGE', 'El cuerpo de la solicitud es demasiado grande');
  } else if ('statusCode' in err && typeof err.statusCode === 'number' && err.statusCode < 500 && !(err instanceof AppError)) {
    appErr = new AppError(err.statusCode, 'VALIDATION_FAILED', err.message);
  } else {
    appErr = toAppError(err);
  }
  if (appErr.status >= 500) req.log.error({ err }, 'error no controlado');
  void reply
    .status(appErr.status)
    .type('application/problem+json')
    .send({
      type: `https://duelo-magos.dev/problems/${appErr.code.toLowerCase().replaceAll('_', '-')}`,
      title: TITLES[appErr.status] ?? 'Error',
      status: appErr.status,
      detail: appErr.message,
      instance: req.url,
      code: appErr.code,
      traceId: req.id,
      ...appErr.extra,
    });
}
