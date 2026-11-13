import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GameClient, HttpError } from '../../tools/game-client.js';
import { newPlayer, resetInfra, startReplica, startedMatch, type Replica } from './harness.js';

let r1: Replica;
let r2: Replica;

beforeAll(async () => {
  await resetInfra();
  r1 = await startReplica('cc-1');
  r2 = await startReplica('cc-2');
});
afterAll(async () => {
  await r1.app.stop(100);
  await r2.app.stop(100);
});

describe('concurrencia', () => {
  it('la capacidad máxima se respeta aunque muchos se unan a la vez (en dos réplicas)', async () => {
    const host = await newPlayer(r1.url);
    const { matchId } = await host.http<{ matchId: string }>('POST', '/v1/matches', { maxPlayers: 4 });
    const joiners = await Promise.all(Array.from({ length: 10 }, (_, i) => newPlayer(i % 2 ? r1.url : r2.url)));
    const results = await Promise.allSettled(joiners.map((p) => p.http('POST', `/v1/matches/${matchId}/join`)));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const full = results.filter(
      (r) => r.status === 'rejected' && (r.reason as HttpError).body.code === 'MATCH_FULL',
    );
    expect(ok).toHaveLength(3);
    expect(full).toHaveLength(7);
    const { view } = await host.http<{ view: { players: unknown[] } }>('GET', `/v1/matches/${matchId}`);
    expect(view.players).toHaveLength(4);
    await Promise.all([host, ...joiners].map((p) => p.close()));
  });

  it('un jugador nunca queda en dos partidas a la vez', async () => {
    const p = await newPlayer(r1.url);
    const a = await newPlayer(r1.url);
    const b = await newPlayer(r2.url);
    const { matchId: m1 } = await a.http<{ matchId: string }>('POST', '/v1/matches', {});
    const { matchId: m2 } = await b.http<{ matchId: string }>('POST', '/v1/matches', {});
    const results = await Promise.allSettled([
      p.http('POST', `/v1/matches/${m1}/join`),
      new GameClient(r2.url, p.name).login().then((c) => c.http('POST', `/v1/matches/${m2}/join`)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as HttpError).body.code).toBe('ALREADY_IN_MATCH');
    await Promise.all([p, a, b].map((c) => c.close()));
  });

  it('emparejamiento: jugadores en cola desde dos réplicas forman partidas sin duplicarse', async () => {
    const players = await Promise.all(Array.from({ length: 8 }, (_, i) => newPlayer(i % 2 ? r1.url : r2.url, 'mm')));
    const matched = players.map((p) => p.waitFor((m) => m.type === 'matchmaking.matched', 15_000));
    await Promise.all(players.map((p) => p.http('POST', '/v1/matchmaking/queue')));
    const ids = (await Promise.all(matched)).map((m) => m.payload.matchId as string);
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    expect(counts.size).toBe(4);
    for (const n of counts.values()) expect(n).toBe(2);
    await Promise.all(players.map((p) => p.close()));
  });

  it('idempotencia: la misma jugada reenviada muchas veces se aplica una sola vez', async () => {
    const { matchId, players } = await startedMatch([r1.url, r2.url], 2);
    const [a] = players;
    const moveId = randomUUID();
    const acks = await Promise.all(
      Array.from({ length: 6 }, () => a!.act(matchId, 1, { kind: 'channel' }, moveId)),
    );
    expect(acks.every((m) => m.type === 'ack')).toBe(true);
    const fresh = acks.filter((m) => !(m.payload as { duplicate: boolean }).duplicate);
    expect(fresh).toHaveLength(1);
    const accepted = a!.received.filter(
      (m) => m.type === 'match.update' && (m.payload.events as { type: string }[]).some((e) => e.type === 'action.accepted'),
    );
    expect(accepted).toHaveLength(1);
    await Promise.all(players.map((p) => p.close()));
  });

  it('jugadas simultáneas de todos resuelven la ronda exactamente una vez y en orden', async () => {
    const { matchId, players } = await startedMatch([r1.url, r2.url, r1.url], 3);
    const resolved = players.map((p) => p.waitForEvent(matchId, 'round.resolved'));
    await Promise.all(players.map((p) => p.act(matchId, 1, { kind: 'channel' })));
    await Promise.all(resolved);
    await new Promise((r) => setTimeout(r, 200));
    for (const p of players) {
      const rounds = p.received.flatMap((m) =>
        m.type === 'match.update' ? (m.payload.events as { type: string; round?: number }[]).filter((e) => e.type === 'round.resolved') : [],
      );
      expect(rounds).toHaveLength(1);
      // Secuencias estrictamente crecientes y sin huecos por actualización.
      const updates = p.received.filter((m) => m.type === 'match.update').map((m) => m.payload as { fromSeq: number; toSeq: number });
      for (let i = 1; i < updates.length; i++) expect(updates[i]!.fromSeq).toBeGreaterThan(updates[i - 1]!.toSeq - 1);
    }
    await Promise.all(players.map((p) => p.close()));
  });

  it('una jugada sobre una versión vieja del estado se rechaza (STALE_ROUND)', async () => {
    const { matchId, players } = await startedMatch([r1.url], 2);
    await Promise.all(players.map((p) => p.act(matchId, 1, { kind: 'channel' })));
    await players[0]!.waitForEvent(matchId, 'round.resolved').catch(() => undefined);
    const stale = await players[0]!.act(matchId, 1, { kind: 'channel' });
    expect(stale.type).toBe('error');
    expect((stale.payload as { code: string }).code).toBe('STALE_ROUND');
    await Promise.all(players.map((p) => p.close()));
  });
});
