import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GameClient } from '../../tools/game-client.js';
import { resetInfra, sleep, startReplica, startedMatch, type Replica } from './harness.js';

let r1: Replica;
let r2: Replica;
const fast = { ROUND_MS: '1500', GRACE_MS: '1500' };

beforeAll(async () => {
  await resetInfra();
  r1 = await startReplica('rs-1', fast);
  r2 = await startReplica('rs-2', fast);
});
afterAll(async () => {
  await r2.app.stop(100);
});

describe('resiliencia', () => {
  it('temporizador por ronda: quien no juega canaliza por defecto', async () => {
    const { matchId, players } = await startedMatch([r1.url, r2.url], 2);
    await players[0]!.act(matchId, 1, { kind: 'channel' });
    const resolved = await players[0]!.waitForEvent(matchId, 'round.resolved', 5000);
    const outcomes = resolved.outcomes as { playerId: string; defaulted: boolean }[];
    expect(outcomes.find((o) => o.playerId === players[1]!.userId)?.defaulted).toBe(true);
    await Promise.all(players.map((p) => p.close()));
  });

  it('reconexión dentro del periodo de gracia recupera el estado actual', async () => {
    const { matchId, players } = await startedMatch([r1.url, r2.url], 2);
    const [a, b] = players;
    await b!.close();
    await sleep(300);
    const again = new GameClient(r1.url, b!.name);
    await again.login();
    await again.connect();
    const view = await again.subscribe(matchId);
    expect(view.status).toBe('active');
    expect(view.you?.affinity).toBeTruthy();
    await a!.close();
    await again.close();
  });

  it('si no reconecta, al vencer la gracia se aplica la regla de abandono', async () => {
    const { matchId, players } = await startedMatch([r1.url, r2.url], 2);
    const [a, b] = players;
    const ended = a!.waitForEvent(matchId, 'match.ended', 8000);
    await b!.close();
    const e = await ended;
    expect(e.result).toMatchObject({ winners: [a!.userId], reason: 'abandonment' });
    await a!.close();
  });

  it('si una réplica se apaga (despliegue), los clientes reconectan a otra y la partida continúa', async () => {
    const slow = { ROUND_MS: '60000', GRACE_MS: '60000' };
    const ra = await startReplica('rs-a', slow);
    const rb = await startReplica('rs-b', slow);
    const { matchId, players } = await startedMatch([ra.url, rb.url], 2);
    const [onA, onB] = players;
    await onA!.act(matchId, 1, { kind: 'channel' });

    const closed = new Promise<number>((res) => onA!.ws!.once('close', (c) => res(c)));
    await ra.app.stop(500); // cierre ordenado
    expect(await closed).toBe(4012);

    // El cliente reconecta a la otra réplica: la jugada ya confirmada no se perdió.
    const back = new GameClient(rb.url, onA!.name);
    await back.login();
    await back.connect();
    const view = await back.subscribe(matchId);
    expect(view.status).toBe('active');
    expect(view.you?.pendingAction).toEqual({ kind: 'channel' });

    const resolved = back.waitForEvent(matchId, 'round.resolved');
    await onB!.act(matchId, 1, { kind: 'channel' });
    await resolved;
    await back.close();
    await onB!.close();
    await rb.app.stop(100);
  });

  it('las partidas sobreviven al reinicio de todas las réplicas (estado durable)', async () => {
    const slow = { ROUND_MS: '60000', GRACE_MS: '60000' };
    let rep = await startReplica('rs-c', slow);
    const { matchId, players } = await startedMatch([rep.url], 2);
    await players[0]!.act(matchId, 1, { kind: 'shield' });
    for (const p of players) await p.close();
    await rep.app.stop(100);
    rep = await startReplica('rs-d', slow);
    const c = new GameClient(rep.url, players[0]!.name);
    await c.login();
    await c.connect();
    const view = await c.subscribe(matchId);
    expect(view.round).toBe(1);
    expect(view.you?.pendingAction).toEqual({ kind: 'shield' });
    await c.close();
    await rep.app.stop(100);
  });

  it('aislamiento: un error en una partida no afecta a las demás', async () => {
    const g1 = await startedMatch([r2.url], 2);
    const g2 = await startedMatch([r2.url], 2);
    // Jugada inválida en g1 (objetivo inexistente): error tipado, sin efectos en g2.
    const bad = await g1.players[0]!.act(g1.matchId, 1, {
      kind: 'attack',
      element: 'fuego',
      target: '00000000-0000-4000-8000-000000000000',
    });
    expect((bad.payload as { code: string }).code).toBe('INVALID_TARGET');
    const resolved = g2.players[0]!.waitForEvent(g2.matchId, 'round.resolved');
    await Promise.all(g2.players.map((p) => p.act(g2.matchId, 1, { kind: 'channel' })));
    await resolved;
    for (const p of [...g1.players, ...g2.players]) await p.close();
  });

  it('salas inactivas expiran y liberan recursos', async () => {
    await r1.app.stop(100);
    const rep = await startReplica('rs-e', { LOBBY_TTL_MS: '10000' });
    const c = new GameClient(rep.url);
    await c.register();
    const { matchId } = await c.http<{ matchId: string }>('POST', '/v1/matches', {});
    await rep.app.db.query("UPDATE matches SET deadline = now() - interval '1 second', state = jsonb_set(state, '{lastActivityAt}', '0') WHERE id = $1", [matchId]);
    await sleep(800);
    const { view } = await c.http<{ view: { status: string } }>('GET', `/v1/matches/${matchId}`);
    expect(view.status).toBe('aborted');
    // Ya no está asignado a ninguna partida: puede crear otra.
    await c.http('POST', '/v1/matches', {});
    await rep.app.stop(100);
  });
});
