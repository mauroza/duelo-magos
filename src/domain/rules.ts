import { DomainError } from './errors.js';
import {
  BEATS,
  ELEMENTS,
  type Action,
  type DomainEvent,
  type Element,
  type MatchConfig,
  type MatchResult,
  type MatchState,
  type PlayerState,
  type PublicPlayer,
  type RandomSource,
  type RoundOutcome,
} from './types.js';

/** Resultado de toda transición: el nuevo estado y los eventos que produjo. */
export interface Transition {
  readonly state: MatchState;
  readonly events: readonly DomainEvent[];
}

export const BASE_DAMAGE = 2;
export const AFFINITY_BONUS = 1;
export const COUNTER_BONUS = 2;
export const CHANNEL_VULNERABILITY = 1;
export const CHANNEL_GAIN = 2;
export const SPELL_COST = 1;

const newPlayer = (id: string, name: string, config: MatchConfig): PlayerState => ({
  id,
  name,
  ready: false,
  hp: config.startHp,
  mana: config.startMana,
  alive: true,
  affinity: null,
  connected: false,
  disconnectedAt: null,
  lastShieldRound: null,
  abandoned: false,
});

const findPlayer = (state: MatchState, playerId: string): PlayerState => {
  const p = state.players.find((x) => x.id === playerId);
  if (!p) throw new DomainError('NOT_A_PARTICIPANT', 'El usuario no participa en esta partida');
  return p;
};

const replacePlayer = (state: MatchState, updated: PlayerState): MatchState => ({
  ...state,
  players: state.players.map((p) => (p.id === updated.id ? updated : p)),
});

const lobbyEvent = (state: MatchState): DomainEvent => ({
  type: 'lobby.updated',
  to: 'all',
  players: state.players.map(({ id, name, ready }) => ({ id, name, ready })),
});

export const publicPlayers = (state: MatchState): PublicPlayer[] =>
  state.players.map(({ id, name, hp, mana, alive, connected }) => ({ id, name, hp, mana, alive, connected }));

export function createMatch(input: {
  id: string;
  host: { id: string; name: string };
  config: MatchConfig;
  now: number;
}): Transition {
  const { config } = input;
  if (config.minPlayers < 2 || config.maxPlayers < config.minPlayers) {
    throw new RangeError('Configuración inválida: mínimo 2 jugadores y máximo >= mínimo');
  }
  const state: MatchState = {
    id: input.id,
    status: 'lobby',
    config,
    hostId: input.host.id,
    players: [newPlayer(input.host.id, input.host.name, config)],
    round: 0,
    pending: {},
    roundDeadline: null,
    lastActivityAt: input.now,
    result: null,
  };
  return { state, events: [lobbyEvent(state)] };
}

export function join(state: MatchState, player: { id: string; name: string }, now: number): Transition {
  if (state.status !== 'lobby') throw new DomainError('MATCH_NOT_IN_LOBBY', 'La partida ya no acepta jugadores');
  if (state.players.some((p) => p.id === player.id)) {
    throw new DomainError('ALREADY_JOINED', 'El jugador ya está en la sala');
  }
  if (state.players.length >= state.config.maxPlayers) {
    throw new DomainError('MATCH_FULL', 'La sala está llena');
  }
  const next: MatchState = {
    ...state,
    players: [...state.players, newPlayer(player.id, player.name, state.config)],
    lastActivityAt: now,
  };
  return { state: next, events: [lobbyEvent(next)] };
}

export function leave(state: MatchState, playerId: string, now: number): Transition {
  findPlayer(state, playerId);
  if (state.status === 'active') return abandon(state, playerId, now);
  if (state.status !== 'lobby') throw new DomainError('MATCH_NOT_IN_LOBBY', 'La partida ya terminó');
  const players = state.players.filter((p) => p.id !== playerId);
  if (players.length === 0) {
    const aborted: MatchState = { ...state, players, status: 'aborted', lastActivityAt: now };
    return { state: aborted, events: [{ type: 'match.expired', to: 'all' }] };
  }
  const hostId = state.hostId === playerId ? (players[0]?.id ?? state.hostId) : state.hostId;
  const next: MatchState = { ...state, players, hostId, lastActivityAt: now };
  return { state: next, events: [lobbyEvent(next)] };
}

export function setReady(
  state: MatchState,
  playerId: string,
  ready: boolean,
  now: number,
  rng: RandomSource,
): Transition {
  if (state.status !== 'lobby') throw new DomainError('MATCH_NOT_IN_LOBBY', 'La partida ya inició');
  const player = findPlayer(state, playerId);
  const next = { ...replacePlayer(state, { ...player, ready }), lastActivityAt: now };
  const events: DomainEvent[] = [lobbyEvent(next)];
  const allReady = next.players.every((p) => p.ready);
  if (allReady && next.players.length >= next.config.minPlayers) {
    const started = start(next, now, rng);
    return { state: started.state, events: [...events, ...started.events] };
  }
  return { state: next, events };
}

/** Inicia la partida. Exige al menos `minPlayers` jugadores listos (o emparejados). */
export function start(state: MatchState, now: number, rng: RandomSource): Transition {
  if (state.status !== 'lobby') throw new DomainError('MATCH_NOT_IN_LOBBY', 'La partida ya inició');
  if (state.players.length < state.config.minPlayers) {
    throw new DomainError('NOT_ENOUGH_PLAYERS', 'Se necesitan al menos 2 jugadores');
  }
  const players = state.players.map((p) => ({
    ...p,
    ready: true,
    affinity: ELEMENTS[rng.int(ELEMENTS.length)] ?? 'fuego',
    // Quien no está conectado al iniciar entra directamente en periodo de gracia.
    disconnectedAt: p.connected ? null : now,
  }));
  const deadline = now + state.config.roundMs;
  const next: MatchState = {
    ...state,
    status: 'active',
    players,
    round: 1,
    pending: {},
    roundDeadline: deadline,
    lastActivityAt: now,
  };
  const events: DomainEvent[] = [
    { type: 'match.started', to: 'all', round: 1, deadline, players: publicPlayers(next) },
    ...players.map(
      (p): DomainEvent => ({ type: 'affinity.assigned', to: p.id, affinity: p.affinity ?? 'fuego' }),
    ),
  ];
  return { state: next, events };
}

/** Valida una intención contra las reglas y el estado actual. No muta nada. */
export function validateAction(state: MatchState, playerId: string, round: number, action: Action): void {
  if (state.status !== 'active') throw new DomainError('MATCH_NOT_ACTIVE', 'La partida no está en curso');
  const player = findPlayer(state, playerId);
  if (!player.alive) throw new DomainError('PLAYER_ELIMINATED', 'El mago fue eliminado');
  if (round !== state.round) {
    throw new DomainError('STALE_ROUND', `La jugada es de la ronda ${round}, la actual es ${state.round}`);
  }
  if (state.pending[playerId]) throw new DomainError('ALREADY_ACTED', 'Ya jugaste en esta ronda');
  switch (action.kind) {
    case 'attack': {
      if (player.mana < SPELL_COST) throw new DomainError('NOT_ENOUGH_MANA', 'No hay maná para atacar');
      const target = state.players.find((p) => p.id === action.target);
      if (!target || !target.alive || target.id === playerId) {
        throw new DomainError('INVALID_TARGET', 'El objetivo debe ser otro mago vivo');
      }
      return;
    }
    case 'shield':
      if (player.mana < SPELL_COST) throw new DomainError('NOT_ENOUGH_MANA', 'No hay maná para el escudo');
      if (player.lastShieldRound === state.round - 1) {
        throw new DomainError('SHIELD_COOLDOWN', 'No se puede usar escudo dos rondas seguidas');
      }
      return;
    case 'channel':
      return;
  }
}

export function submitAction(
  state: MatchState,
  playerId: string,
  round: number,
  action: Action,
  now: number,
): Transition {
  validateAction(state, playerId, round, action);
  const next: MatchState = { ...state, pending: { ...state.pending, [playerId]: action }, lastActivityAt: now };
  const accepted: DomainEvent = { type: 'action.accepted', to: 'all', round, playerId };
  const alive = next.players.filter((p) => p.alive);
  if (alive.every((p) => next.pending[p.id])) {
    const resolved = resolveRound(next, now);
    return { state: resolved.state, events: [accepted, ...resolved.events] };
  }
  return { state: next, events: [accepted] };
}

/** Daño que `attacker` inflige con `element` a un objetivo que eligió `targetAction`. */
export function computeDamage(
  element: Element,
  attackerAffinity: Element | null,
  targetAction: Action,
): number {
  if (targetAction.kind === 'shield') return 0;
  let dmg = BASE_DAMAGE;
  if (element === attackerAffinity) dmg += AFFINITY_BONUS;
  if (targetAction.kind === 'attack' && BEATS[element] === targetAction.element) dmg += COUNTER_BONUS;
  if (targetAction.kind === 'channel') dmg += CHANNEL_VULNERABILITY;
  return dmg;
}

/** Resuelve la ronda: todas las acciones se aplican de forma simultánea. */
export function resolveRound(state: MatchState, now: number): Transition {
  if (state.status !== 'active') throw new DomainError('MATCH_NOT_ACTIVE', 'La partida no está en curso');
  const alive = state.players.filter((p) => p.alive);
  const actions = new Map<string, { action: Action; defaulted: boolean }>();
  for (const p of alive) {
    const a = state.pending[p.id];
    actions.set(p.id, a ? { action: a, defaulted: false } : { action: { kind: 'channel' }, defaulted: true });
  }

  const damage = new Map<string, number>();
  for (const p of alive) {
    const entry = actions.get(p.id);
    if (entry?.action.kind !== 'attack') continue;
    const targetEntry = actions.get(entry.action.target);
    if (!targetEntry) continue; // el objetivo abandonó o murió antes de resolver
    const dmg = computeDamage(entry.action.element, p.affinity, targetEntry.action);
    damage.set(entry.action.target, (damage.get(entry.action.target) ?? 0) + dmg);
  }

  const outcomes: RoundOutcome[] = [];
  const players = state.players.map((p): PlayerState => {
    const entry = actions.get(p.id);
    if (!p.alive || !entry) return p;
    const taken = damage.get(p.id) ?? 0;
    const hp = Math.max(0, p.hp - taken);
    let mana = p.mana;
    if (entry.action.kind === 'attack' || entry.action.kind === 'shield') mana -= SPELL_COST;
    if (entry.action.kind === 'channel') mana = Math.min(state.config.maxMana, mana + CHANNEL_GAIN);
    const updated: PlayerState = {
      ...p,
      hp,
      mana,
      alive: hp > 0,
      lastShieldRound: entry.action.kind === 'shield' ? state.round : p.lastShieldRound,
    };
    outcomes.push({
      playerId: p.id,
      action: entry.action,
      defaulted: entry.defaulted,
      damageTaken: taken,
      hp,
      mana,
      alive: updated.alive,
    });
    return updated;
  });

  const afterRound: MatchState = { ...state, players, pending: {}, lastActivityAt: now };
  const ending = checkEnd(afterRound);
  if (ending) {
    const finished = finish(afterRound, ending, now);
    const resolved: DomainEvent = {
      type: 'round.resolved',
      to: 'all',
      round: state.round,
      outcomes,
      nextDeadline: null,
    };
    return { state: finished.state, events: [resolved, ...finished.events] };
  }
  const nextDeadline = now + state.config.roundMs;
  const next: MatchState = { ...afterRound, round: state.round + 1, roundDeadline: nextDeadline };
  return {
    state: next,
    events: [{ type: 'round.resolved', to: 'all', round: state.round, outcomes, nextDeadline }],
  };
}

function checkEnd(state: MatchState, reasonIfLast: MatchResult['reason'] = 'last_standing'): MatchResult | null {
  const alive = state.players.filter((p) => p.alive);
  if (alive.length === 0) return { winners: [], draw: true, reason: 'all_eliminated' };
  if (alive.length === 1) return { winners: [alive[0]?.id ?? ''], draw: false, reason: reasonIfLast };
  if (state.round >= state.config.maxRounds) {
    const best = Math.max(...alive.map((p) => p.hp));
    const winners = alive.filter((p) => p.hp === best).map((p) => p.id);
    return { winners: winners.length === 1 ? winners : [], draw: winners.length !== 1, reason: 'max_rounds' };
  }
  return null;
}

function finish(state: MatchState, result: MatchResult, now: number): Transition {
  const next: MatchState = { ...state, status: 'finished', result, roundDeadline: null, pending: {}, lastActivityAt: now };
  const affinities: Record<string, Element> = {};
  for (const p of state.players) if (p.affinity) affinities[p.id] = p.affinity;
  return { state: next, events: [{ type: 'match.ended', to: 'all', result, affinities }] };
}

/** Regla de abandono: el mago queda eliminado. Si queda uno solo, gana por abandono. */
export function abandon(state: MatchState, playerId: string, now: number): Transition {
  const player = findPlayer(state, playerId);
  if (state.status !== 'active') throw new DomainError('MATCH_NOT_ACTIVE', 'La partida no está en curso');
  if (!player.alive) return { state, events: [] };
  const pending = Object.fromEntries(Object.entries(state.pending).filter(([id]) => id !== playerId));
  const next = {
    ...replacePlayer(state, { ...player, alive: false, hp: 0, abandoned: true }),
    pending,
    lastActivityAt: now,
  };
  const events: DomainEvent[] = [{ type: 'player.abandoned', to: 'all', playerId }];
  const ending = checkEnd({ ...next, round: 0 }, 'abandonment');
  if (ending) {
    const finished = finish(next, ending, now);
    return { state: finished.state, events: [...events, ...finished.events] };
  }
  const alive = next.players.filter((p) => p.alive);
  if (alive.every((p) => next.pending[p.id])) {
    const resolved = resolveRound(next, now);
    return { state: resolved.state, events: [...events, ...resolved.events] };
  }
  return { state: next, events };
}

export function setPresence(state: MatchState, playerId: string, connected: boolean, now: number): Transition {
  const player = findPlayer(state, playerId);
  if (player.connected === connected) return { state, events: [] };
  const inGame = state.status === 'active' && player.alive;
  const disconnectedAt = connected ? null : inGame ? now : null;
  const next = replacePlayer(state, { ...player, connected, disconnectedAt });
  if (state.status !== 'active' && state.status !== 'lobby') return { state: next, events: [] };
  return {
    state: next,
    events: [
      {
        type: 'player.presence',
        to: 'all',
        playerId,
        connected,
        graceUntil: disconnectedAt === null ? null : disconnectedAt + state.config.graceMs,
      },
    ],
  };
}

/** Termina la partida por decisión de un administrador. */
export function terminate(state: MatchState, now: number): Transition {
  if (state.status === 'finished' || state.status === 'aborted') {
    throw new DomainError('MATCH_NOT_ACTIVE', 'La partida ya terminó');
  }
  const result: MatchResult = { winners: [], draw: true, reason: 'terminated' };
  const finished = finish(state, result, now);
  return { state: { ...finished.state, status: 'aborted' }, events: finished.events };
}

/** Próximo instante en el que el reloj del servidor debe actuar sobre esta partida. */
export function nextDeadline(state: MatchState): number | null {
  if (state.status === 'lobby') return state.lastActivityAt + state.config.lobbyTtlMs;
  if (state.status !== 'active') return null;
  const candidates = [state.roundDeadline ?? Number.POSITIVE_INFINITY];
  for (const p of state.players) {
    if (p.alive && p.disconnectedAt !== null) candidates.push(p.disconnectedAt + state.config.graceMs);
  }
  const min = Math.min(...candidates);
  return Number.isFinite(min) ? min : null;
}

/** Avanza el reloj: expira salas, aplica abandonos y la acción por defecto al vencer la ronda. */
export function tick(state: MatchState, now: number): Transition {
  if (state.status === 'lobby') {
    if (now >= state.lastActivityAt + state.config.lobbyTtlMs) {
      return { state: { ...state, status: 'aborted', lastActivityAt: now }, events: [{ type: 'match.expired', to: 'all' }] };
    }
    return { state, events: [] };
  }
  if (state.status !== 'active') return { state, events: [] };
  let current = state;
  const events: DomainEvent[] = [];
  for (const p of state.players) {
    if (current.status !== 'active') break;
    if (p.alive && p.disconnectedAt !== null && now >= p.disconnectedAt + state.config.graceMs) {
      const t = abandon(current, p.id, now);
      current = t.state;
      events.push(...t.events);
    }
  }
  if (current.status === 'active' && current.roundDeadline !== null && now >= current.roundDeadline) {
    const t = resolveRound(current, now);
    current = t.state;
    events.push(...t.events);
  }
  return { state: current, events };
}

/** Vista filtrada para un jugador: nunca incluye información oculta de otros magos. */
export interface PlayerView {
  readonly matchId: string;
  readonly status: MatchState['status'];
  readonly hostId: string;
  readonly round: number;
  readonly roundDeadline: number | null;
  readonly config: Pick<MatchConfig, 'minPlayers' | 'maxPlayers' | 'roundMs' | 'graceMs' | 'maxRounds' | 'maxMana'>;
  readonly players: readonly (PublicPlayer & { readonly ready: boolean; readonly hasActed: boolean })[];
  readonly you: { readonly id: string; readonly affinity: Element | null; readonly pendingAction: Action | null } | null;
  readonly result: MatchResult | null;
  readonly affinities: Readonly<Record<string, Element>> | null;
}

export function playerView(state: MatchState, viewerId: string | null): PlayerView {
  const me = viewerId ? state.players.find((p) => p.id === viewerId) : undefined;
  const ended = state.status === 'finished' || state.status === 'aborted';
  const affinities: Record<string, Element> = {};
  if (ended) for (const p of state.players) if (p.affinity) affinities[p.id] = p.affinity;
  const { minPlayers, maxPlayers, roundMs, graceMs, maxRounds, maxMana } = state.config;
  return {
    matchId: state.id,
    status: state.status,
    hostId: state.hostId,
    round: state.round,
    roundDeadline: state.roundDeadline,
    config: { minPlayers, maxPlayers, roundMs, graceMs, maxRounds, maxMana },
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      hp: p.hp,
      mana: p.mana,
      alive: p.alive,
      connected: p.connected,
      ready: p.ready,
      hasActed: Boolean(state.pending[p.id]),
    })),
    you: me ? { id: me.id, affinity: me.affinity, pendingAction: state.pending[me.id] ?? null } : null,
    result: state.result,
    affinities: ended ? affinities : null,
  };
}
