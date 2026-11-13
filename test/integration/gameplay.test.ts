import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chooseAction, type GameClient, type View } from '../../tools/game-client.js';
import { newPlayer, resetInfra, startReplica, startedMatch, type Replica } from './harness.js';

let r1: Replica;
let r2: Replica;

beforeAll(async () => {
  await resetInfra();
  r1 = await startReplica('it-1');
  r2 = await startReplica('it-2');
});
afterAll(async () => {
  await r1.app.stop(100);
  await r2.app.stop(100);
});

async function playToEnd(matchId: string, players: GameClient[]): Promise<View> {
  for (let guard = 0; guard < 40; guard++) {
    const view = players[0]!.views.get(matchId)!;
    if (view.status !== 'active') return view;
    const round = view.round;
    const resolved = players[0]!.waitFor(
      (m) =>
        m.type === 'match.update' &&
        (m.payload as { events: { type: string; round?: number }[] }).events.some(
          (e) => e.type === 'round.resolved' && e.round === round,
        ),
    );
    for (const p of players) {
      const v = p.views.get(matchId)!;
      const me = v.players.find((x) => x.id === p.userId);
      if (!me?.alive) continue;
      const ack = await p.act(matchId, round, chooseAction(v));
      expect(ack.type, JSON.stringify(ack.payload)).toBe('ack');
    }
    await resolved;
    await new Promise((r) => setTimeout(r, 30));
  }
  return players[0]!.views.get(matchId)!;
}

describe('partida completa entre dos réplicas', () => {
  it('juega hasta el final, registra el resultado inmutable y permite reproducirla', async () => {
    // Cada jugador está conectado a una réplica distinta: la difusión pasa por Redis.
    const { matchId, players } = await startedMatch([r1.url, r2.url], 2);
    const final = await playToEnd(matchId, players);
    expect(final.status).toBe('finished');
    expect(final.result).not.toBeNull();
    expect(final.affinities).not.toBeNull();

    // Ambos ven el mismo resultado.
    const [a, b] = players;
    const va = await a!.http<{ view: View }>('GET', `/v1/matches/${matchId}`);
    const vb = await b!.http<{ view: View }>('GET', `/v1/matches/${matchId}`);
    expect(va.view.result).toEqual(vb.view.result);

    const history = await a!.http<{ items: { matchId: string }[] }>('GET', '/v1/history?limit=5');
    expect(history.items.map((i) => i.matchId)).toContain(matchId);

    const replay = await a!.http<{ events: { seq: number; event: { type: string } }[] }>('GET', `/v1/matches/${matchId}/replay`);
    const seqs = replay.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(replay.events.at(-1)?.event.type).toBe('match.ended');

    for (const p of players) await p.close();
  });

  it('muchas partidas simultáneas no interfieren entre sí', async () => {
    const games = await Promise.all(Array.from({ length: 6 }, () => startedMatch([r1.url, r2.url], 2)));
    const finals = await Promise.all(games.map((g) => playToEnd(g.matchId, g.players)));
    for (const f of finals) expect(f.status).toBe('finished');
    // Ningún jugador ve eventos de otra partida.
    for (const g of games) {
      for (const p of g.players) {
        const foreign = p.received.filter(
          (m) => typeof m.payload.matchId === 'string' && m.payload.matchId !== g.matchId,
        );
        expect(foreign).toHaveLength(0);
        await p.close();
      }
    }
  });

  it('sala privada: solo se entra con código de invitación', async () => {
    const host = await newPlayer(r1.url);
    const other = await newPlayer(r2.url);
    const { matchId, inviteCode } = await host.http<{ matchId: string; inviteCode: string }>('POST', '/v1/matches', {
      visibility: 'private',
    });
    await expect(other.http('POST', `/v1/matches/${matchId}/join`)).rejects.toMatchObject({ status: 403 });
    const list = await other.http<{ items: { id: string }[] }>('GET', '/v1/matches');
    expect(list.items.map((i) => i.id)).not.toContain(matchId);
    const view = await other.http<View>('POST', '/v1/matches/join-by-code', { code: inviteCode });
    expect(view.players).toHaveLength(2);
    await host.close();
    await other.close();
  });
});
