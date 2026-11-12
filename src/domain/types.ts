/**
 * Duelo de Magos — modelo de dominio puro.
 * Sin dependencias de red, base de datos ni framework (lo verifica eslint).
 */

export const ELEMENTS = ['fuego', 'agua', 'tierra'] as const;
export type Element = (typeof ELEMENTS)[number];

/** Qué elemento vence a cuál: agua apaga fuego, fuego calcina tierra, tierra absorbe agua. */
export const BEATS: Readonly<Record<Element, Element>> = {
  agua: 'fuego',
  fuego: 'tierra',
  tierra: 'agua',
};

export type Action =
  | { readonly kind: 'attack'; readonly element: Element; readonly target: string }
  | { readonly kind: 'shield' }
  | { readonly kind: 'channel' };

export type MatchStatus = 'lobby' | 'active' | 'finished' | 'aborted';

export interface MatchConfig {
  readonly minPlayers: number;
  readonly maxPlayers: number;
  /** Duración de cada ronda; al vencer, quien no jugó canaliza (acción por defecto). */
  readonly roundMs: number;
  /** Periodo de gracia tras una desconexión antes de aplicar la regla de abandono. */
  readonly graceMs: number;
  readonly maxRounds: number;
  readonly startHp: number;
  readonly startMana: number;
  readonly maxMana: number;
  /** Tiempo máximo que una sala puede estar inactiva antes de expirar. */
  readonly lobbyTtlMs: number;
}

export const DEFAULT_CONFIG: MatchConfig = {
  minPlayers: 2,
  maxPlayers: 4,
  roundMs: 20_000,
  graceMs: 30_000,
  maxRounds: 15,
  startHp: 12,
  startMana: 2,
  maxMana: 6,
  lobbyTtlMs: 10 * 60_000,
};

export interface PlayerState {
  readonly id: string;
  readonly name: string;
  readonly ready: boolean;
  readonly hp: number;
  readonly mana: number;
  readonly alive: boolean;
  /** Elemento afín secreto (información oculta), asignado al azar con un CSPRNG al iniciar. */
  readonly affinity: Element | null;
  readonly connected: boolean;
  readonly disconnectedAt: number | null;
  readonly lastShieldRound: number | null;
  readonly abandoned: boolean;
}

export interface RoundOutcome {
  readonly playerId: string;
  readonly action: Action;
  readonly defaulted: boolean;
  readonly damageTaken: number;
  readonly hp: number;
  readonly mana: number;
  readonly alive: boolean;
}

export interface MatchResult {
  readonly winners: readonly string[];
  readonly draw: boolean;
  readonly reason: 'last_standing' | 'max_rounds' | 'all_eliminated' | 'abandonment' | 'terminated';
}

export interface MatchState {
  readonly id: string;
  readonly status: MatchStatus;
  readonly config: MatchConfig;
  readonly hostId: string;
  readonly players: readonly PlayerState[];
  readonly round: number;
  /** Acciones secretas de la ronda en curso. Nunca se envían a otros jugadores. */
  readonly pending: Readonly<Record<string, Action>>;
  readonly roundDeadline: number | null;
  readonly lastActivityAt: number;
  readonly result: MatchResult | null;
}

/** Eventos de dominio. `to` indica quién puede verlos: todos o un único jugador. */
export type DomainEvent =
  | { readonly type: 'lobby.updated'; readonly to: 'all'; readonly players: readonly LobbyPlayer[] }
  | { readonly type: 'match.started'; readonly to: 'all'; readonly round: number; readonly deadline: number; readonly players: readonly PublicPlayer[] }
  | { readonly type: 'affinity.assigned'; readonly to: string; readonly affinity: Element }
  | { readonly type: 'action.accepted'; readonly to: 'all'; readonly round: number; readonly playerId: string }
  | { readonly type: 'round.resolved'; readonly to: 'all'; readonly round: number; readonly outcomes: readonly RoundOutcome[]; readonly nextDeadline: number | null }
  | { readonly type: 'player.presence'; readonly to: 'all'; readonly playerId: string; readonly connected: boolean; readonly graceUntil: number | null }
  | { readonly type: 'player.abandoned'; readonly to: 'all'; readonly playerId: string }
  | { readonly type: 'match.ended'; readonly to: 'all'; readonly result: MatchResult; readonly affinities: Readonly<Record<string, Element>> }
  | { readonly type: 'match.expired'; readonly to: 'all' };

export interface LobbyPlayer {
  readonly id: string;
  readonly name: string;
  readonly ready: boolean;
}

export interface PublicPlayer {
  readonly id: string;
  readonly name: string;
  readonly hp: number;
  readonly mana: number;
  readonly alive: boolean;
  readonly connected: boolean;
}

/** Fuente de azar inyectada: en producción es criptográficamente segura (crypto.randomInt). */
export interface RandomSource {
  /** Entero uniforme en [0, maxExclusive). */
  int(maxExclusive: number): number;
}
