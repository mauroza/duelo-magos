import { DOMAIN_ERROR_CODES, DomainError, type DomainErrorCode } from '../domain/index.js';

export const APP_ERROR_CODES = [
  ...DOMAIN_ERROR_CODES,
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'TOKEN_REUSED',
  'ACCOUNT_SUSPENDED',
  'FORBIDDEN',
  'NOT_FOUND',
  'USERNAME_TAKEN',
  'ALREADY_IN_MATCH',
  'INVALID_INVITE_CODE',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_VERSION',
  'INTERNAL',
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

/** Error de aplicación que se serializa como RFC 9457 Problem Details (HTTP) o mensaje `error` (WebSocket). */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: AppErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

const DOMAIN_STATUS: Record<DomainErrorCode, number> = {
  MATCH_NOT_IN_LOBBY: 409,
  MATCH_NOT_ACTIVE: 409,
  MATCH_FULL: 409,
  ALREADY_JOINED: 409,
  NOT_A_PARTICIPANT: 403,
  NOT_ENOUGH_PLAYERS: 409,
  PLAYER_ELIMINATED: 409,
  ALREADY_ACTED: 409,
  STALE_ROUND: 409,
  NOT_ENOUGH_MANA: 422,
  INVALID_TARGET: 422,
  SHIELD_COOLDOWN: 422,
};

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof DomainError) return new AppError(DOMAIN_STATUS[err.code], err.code, err.message);
  return new AppError(500, 'INTERNAL', 'Error interno del servidor');
}
