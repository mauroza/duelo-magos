/**
 * Bot de Duelo de Magos. Usa la cola rápida, juega partidas completas y verifica el resultado.
 *   npx tsx tools/bot.ts --url http://localhost:8080 --games 3
 * Lo usa también la prueba de humo del pipeline después de cada despliegue.
 */
import { parseArgs } from 'node:util';
import { GameClient, chooseAction } from './game-client.js';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:8080' },
    games: { type: 'string', default: '1' },
    timeout: { type: 'string', default: '120' },
  },
});
const url = values.url.replace(/\/$/, '');

async function playOneGame(n: number): Promise<void> {
  const bots = [new GameClient(url, `bot${Date.now()}${n}a`), new GameClient(url, `bot${Date.now()}${n}b`)];
  for (const b of bots) {
    await b.register();
    await b.connect();
  }
  const matched = bots.map((b) => b.waitFor((m) => m.type === 'matchmaking.matched', 60_000));
  for (const b of bots) await b.http('POST', '/v1/matchmaking/queue');
  const matchId = (await matched[0]!).payload.matchId as string;
  await Promise.all(matched);
  console.log(`[partida ${n}] emparejada ${matchId}`);
  await Promise.all(bots.map((b) => b.subscribe(matchId)));

  const finished = Promise.all(bots.map((b) => b.waitForEvent(matchId, 'match.ended', 600_000)));
  const actedRound = new Map<GameClient, number>();
  const loop = async (b: GameClient) => {
    for (;;) {
      const v = b.views.get(matchId);
      if (!v || v.status === 'finished' || v.status === 'aborted') return;
      const me = v.players.find((p) => p.id === b.userId);
      if (v.status === 'active' && me?.alive && actedRound.get(b) !== v.round && !me.hasActed) {
        actedRound.set(b, v.round);
        const res = await b.act(matchId, v.round, chooseAction(v));
        if (res.type === 'error') {
          const code = (res.payload as { code: string }).code;
          if (code !== 'STALE_ROUND') await b.act(matchId, v.round, { kind: 'channel' });
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  await Promise.all([...bots.map(loop), finished]);
  const view = bots[0]!.views.get(matchId)!;
  const winner = view.players.find((p) => view.result?.winners.includes(p.id))?.name ?? 'empate';
  console.log(`[partida ${n}] terminó en la ronda ${view.round}: ${view.result?.reason} — ganador: ${winner}`);
  for (const b of bots) await b.close();
}

const games = Number(values.games);
const timer = setTimeout(() => {
  console.error('Tiempo agotado');
  process.exit(1);
}, Number(values.timeout) * 1000);
Promise.all(Array.from({ length: games }, (_, i) => playOneGame(i + 1)))
  .then(() => {
    clearTimeout(timer);
    console.log(`OK: ${games} partida(s) completas`);
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error('El bot falló:', err);
    process.exit(1);
  });
