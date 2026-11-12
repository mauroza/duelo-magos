import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  DomainError,
  computeDamage,
  createMatch,
  join,
  leave,
  nextDeadline,
  playerView,
  setPresence,
  setReady,
  submitAction,
  tick,
  type MatchState,
  type RandomSource,
} from '../../src/domain/index.js';

const fixedRng = (...values: number[]): RandomSource => {
  let i = 0;
  return { int: (max) => (values[i++ % values.length] ?? 0) % max };
};

const T0 = 1_000_000;

function startedMatch(players = ['a', 'b'], rng = fixedRng(0, 1, 2, 0)): MatchState {
  let s = createMatch({ id: 'm1', host: { id: players[0]!, name: players[0]! }, config: DEFAULT_CONFIG, now: T0 }).state;
  for (const p of players.slice(1)) s = join(s, { id: p, name: p }, T0).state;
  for (const p of players) s = setPresence(s, p, true, T0).state;
  for (const p of players) s = setReady(s, p, true, T0, rng).state;
  return s;
}

const expectCode = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    expect((e as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`Se esperaba DomainError ${code}`);
};

describe('salas', () => {
  it('inicia solo cuando hay 2 o más jugadores listos', () => {
    let s = createMatch({ id: 'm', host: { id: 'a', name: 'A' }, config: DEFAULT_CONFIG, now: T0 }).state;
    s = setReady(s, 'a', true, T0, fixedRng(0)).state;
    expect(s.status).toBe('lobby');
    s = join(s, { id: 'b', name: 'B' }, T0).state;
    s = setReady(s, 'b', true, T0, fixedRng(0)).state;
    expect(s.status).toBe('active');
    expect(s.round).toBe(1);
  });

  it('respeta la capacidad máxima', () => {
    let s = createMatch({ id: 'm', host: { id: 'p0', name: 'p0' }, config: { ...DEFAULT_CONFIG, maxPlayers: 2 }, now: T0 }).state;
    s = join(s, { id: 'p1', name: 'p1' }, T0).state;
    expectCode(() => join(s, { id: 'p2', name: 'p2' }, T0), 'MATCH_FULL');
  });

  it('no permite unirse dos veces', () => {
    const s = createMatch({ id: 'm', host: { id: 'a', name: 'A' }, config: DEFAULT_CONFIG, now: T0 }).state;
    expectCode(() => join(s, { id: 'a', name: 'A' }, T0), 'ALREADY_JOINED');
  });

  it('reasigna el anfitrión si sale y aborta si la sala queda vacía', () => {
    let s = createMatch({ id: 'm', host: { id: 'a', name: 'A' }, config: DEFAULT_CONFIG, now: T0 }).state;
    s = join(s, { id: 'b', name: 'B' }, T0).state;
    s = leave(s, 'a', T0).state;
    expect(s.hostId).toBe('b');
    s = leave(s, 'b', T0).state;
    expect(s.status).toBe('aborted');
  });

  it('expira salas inactivas', () => {
    const s = createMatch({ id: 'm', host: { id: 'a', name: 'A' }, config: DEFAULT_CONFIG, now: T0 }).state;
    expect(nextDeadline(s)).toBe(T0 + DEFAULT_CONFIG.lobbyTtlMs);
    const t = tick(s, T0 + DEFAULT_CONFIG.lobbyTtlMs);
    expect(t.state.status).toBe('aborted');
    expect(t.events[0]?.type).toBe('match.expired');
  });
});

describe('daño', () => {
  it('escudo bloquea todo', () => {
    expect(computeDamage('fuego', 'fuego', { kind: 'shield' })).toBe(0);
  });
  it('base, afinidad, contrahechizo y vulnerabilidad al canalizar', () => {
    expect(computeDamage('fuego', null, { kind: 'attack', element: 'agua', target: 'x' })).toBe(2);
    expect(computeDamage('fuego', 'fuego', { kind: 'attack', element: 'agua', target: 'x' })).toBe(3);
    // agua vence a fuego
    expect(computeDamage('agua', null, { kind: 'attack', element: 'fuego', target: 'x' })).toBe(4);
    expect(computeDamage('tierra', null, { kind: 'channel' })).toBe(3);
  });
});

describe('rondas', () => {
  it('resuelve cuando todos jugaron y aplica efectos simultáneos', () => {
    // rng 0 -> a: fuego, 1 -> b: agua
    let s = startedMatch();
    s = submitAction(s, 'a', 1, { kind: 'attack', element: 'tierra', target: 'b' }, T0 + 1).state;
    expect(s.round).toBe(1);
    const t = submitAction(s, 'b', 1, { kind: 'attack', element: 'agua', target: 'a' }, T0 + 2);
    s = t.state;
    expect(s.round).toBe(2);
    const resolved = t.events.find((e) => e.type === 'round.resolved');
    expect(resolved).toBeDefined();
    // a usa tierra, que vence al agua de b: 2 + 2 = 4. b usa agua con afinidad agua: 2 + 1 = 3 (tierra no es vencida por agua).
    expect(s.players.find((p) => p.id === 'b')?.hp).toBe(12 - 4);
    expect(s.players.find((p) => p.id === 'a')?.hp).toBe(12 - 3);
    expect(s.players.find((p) => p.id === 'a')?.mana).toBe(1);
  });

  it('rechaza turnos inválidos con errores tipados', () => {
    let s = startedMatch();
    expectCode(() => submitAction(s, 'a', 2, { kind: 'channel' }, T0), 'STALE_ROUND');
    expectCode(() => submitAction(s, 'x', 1, { kind: 'channel' }, T0), 'NOT_A_PARTICIPANT');
    expectCode(() => submitAction(s, 'a', 1, { kind: 'attack', element: 'agua', target: 'a' }, T0), 'INVALID_TARGET');
    s = submitAction(s, 'a', 1, { kind: 'channel' }, T0).state;
    expectCode(() => submitAction(s, 'a', 1, { kind: 'channel' }, T0), 'ALREADY_ACTED');
  });

  it('no permite escudo dos rondas seguidas ni atacar sin maná', () => {
    let s = startedMatch();
    s = submitAction(s, 'a', 1, { kind: 'shield' }, T0).state;
    s = submitAction(s, 'b', 1, { kind: 'channel' }, T0).state;
    expectCode(() => submitAction(s, 'a', 2, { kind: 'shield' }, T0), 'SHIELD_COOLDOWN');
    s = submitAction(s, 'a', 2, { kind: 'attack', element: 'fuego', target: 'b' }, T0).state;
    s = submitAction(s, 'b', 2, { kind: 'channel' }, T0).state;
    // a: 2 -1 (escudo) -1 (ataque) = 0
    expectCode(() => submitAction(s, 'a', 3, { kind: 'attack', element: 'fuego', target: 'b' }, T0), 'NOT_ENOUGH_MANA');
  });

  it('al vencer el temporizador quien no jugó canaliza por defecto', () => {
    let s = startedMatch();
    s = submitAction(s, 'a', 1, { kind: 'attack', element: 'fuego', target: 'b' }, T0).state;
    const t = tick(s, T0 + DEFAULT_CONFIG.roundMs);
    const resolved = t.events.find((e) => e.type === 'round.resolved');
    expect(resolved && resolved.type === 'round.resolved' && resolved.outcomes.find((o) => o.playerId === 'b')?.defaulted).toBe(true);
    expect(t.state.round).toBe(2);
  });

  it('declara ganador al último mago en pie y el resultado incluye las afinidades', () => {
    let s = startedMatch();
    let round = 1;
    while (s.status === 'active') {
      const a = s.players.find((p) => p.id === 'a')!;
      const action = a.mana > 0 ? ({ kind: 'attack', element: 'fuego', target: 'b' } as const) : ({ kind: 'channel' } as const);
      s = submitAction(s, 'a', round, action, T0).state;
      if (s.status !== 'active') break;
      s = submitAction(s, 'b', round, { kind: 'channel' }, T0).state;
      round++;
    }
    expect(s.status).toBe('finished');
    expect(s.result?.winners).toEqual(['a']);
  });
});

describe('desconexión y abandono', () => {
  it('aplica el periodo de gracia y luego la regla de abandono', () => {
    let s = startedMatch(['a', 'b', 'c']);
    s = setPresence(s, 'c', false, T0 + 10).state;
    expect(nextDeadline(s)).toBe(Math.min(T0 + DEFAULT_CONFIG.roundMs, T0 + 10 + DEFAULT_CONFIG.graceMs));
    // reconecta a tiempo: no hay abandono
    const back = setPresence(s, 'c', true, T0 + 20).state;
    expect(back.players.find((p) => p.id === 'c')?.disconnectedAt).toBeNull();
    // no reconecta: se elimina al vencer la gracia
    const t = tick(s, T0 + 10 + DEFAULT_CONFIG.graceMs);
    expect(t.events.some((e) => e.type === 'player.abandoned')).toBe(true);
    expect(t.state.players.find((p) => p.id === 'c')?.alive).toBe(false);
  });

  it('con 2 jugadores, el abandono da la victoria al otro', () => {
    let s = startedMatch();
    s = leave(s, 'b', T0).state;
    expect(s.status).toBe('finished');
    expect(s.result).toEqual({ winners: ['a'], draw: false, reason: 'abandonment' });
  });
});

describe('vista por jugador (información oculta)', () => {
  it('no revela afinidades ni jugadas pendientes de otros', () => {
    let s = startedMatch();
    s = submitAction(s, 'a', 1, { kind: 'attack', element: 'fuego', target: 'b' }, T0).state;
    const viewB = playerView(s, 'b');
    const json = JSON.stringify(viewB);
    expect(viewB.you?.affinity).toBe('agua');
    expect(json).not.toContain('"fuego"'); // afinidad y jugada de a
    expect(viewB.players.find((p) => p.id === 'a')?.hasActed).toBe(true);
    expect(viewB.affinities).toBeNull();
    const viewA = playerView(s, 'a');
    expect(viewA.you?.pendingAction).toEqual({ kind: 'attack', element: 'fuego', target: 'b' });
  });

  it('los eventos privados solo van a su destinatario', () => {
    let s = createMatch({ id: 'm', host: { id: 'a', name: 'A' }, config: DEFAULT_CONFIG, now: T0 }).state;
    s = join(s, { id: 'b', name: 'B' }, T0).state;
    s = setReady(s, 'a', true, T0, fixedRng(0, 1)).state;
    const t = setReady(s, 'b', true, T0, fixedRng(0, 1));
    const affinityEvents = t.events.filter((e) => e.type === 'affinity.assigned');
    expect(affinityEvents.map((e) => e.to).sort()).toEqual(['a', 'b']);
    expect(t.events.filter((e) => e.type === 'match.started').every((e) => e.to === 'all')).toBe(true);
  });
});
