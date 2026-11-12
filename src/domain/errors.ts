/** Errores tipados del dominio. Cada código está documentado en AsyncAPI y OpenAPI. */
export const DOMAIN_ERROR_CODES = [
  'MATCH_NOT_IN_LOBBY',
  'MATCH_NOT_ACTIVE',
  'MATCH_FULL',
  'ALREADY_JOINED',
  'NOT_A_PARTICIPANT',
  'NOT_ENOUGH_PLAYERS',
  'PLAYER_ELIMINATED',
  'ALREADY_ACTED',
  'STALE_ROUND',
  'NOT_ENOUGH_MANA',
  'INVALID_TARGET',
  'SHIELD_COOLDOWN',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
