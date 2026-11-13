/**
 * Prueba de carga reproducible.
 *
 *   npx tsx load/loadtest.ts --url http://localhost:8080 --matches 50,100,200 --rounds 8 --pid <pid del servidor>
 *
 * Por cada nivel abre N partidas simultáneas de 2 jugadores (2N WebSockets) que juegan rondas sin
 * pausa. Mide, por ronda, el tiempo desde que el servidor recibe la jugada que cierra la ronda hasta
 * que TODOS los jugadores de esa partida reciben `round.resolved` (latencia de difusión de punta a punta,
 * medida en el reloj del cliente: envío -> última recepción). Verifica que no haya jugadas perdidas ni
 * duplicadas (cada ronda se resuelve exactamente una vez por jugador y las secuencias no tienen huecos).
 * Si se pasa --pid, muestrea CPU y memoria del proceso del servidor (Linux /proc).
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { GameClient, chooseAction, type ServerMsg } from '../tools/game-client.js';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:8080' },
    matches: { type: 'string', default: '25,50,100' },
    rounds: { type: 'string', default: '8' },
    pid: { type: 'string' },
    label: { type: 'string', default: 'run' },
  },
});
const url = values.url;
const ROUNDS = Number(values.rounds);

interface LevelResult {
  matches: number;
  connections: number;
  rounds: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  errors: number;
  errorRate: number;
  lost: number;
  duplicated: number;
  bytesPerUpdate: number;
  cpuPct: number | null;
  rssMb: number | null;
  rssPerMatchKb: number | null;
  durationS: number;
}

/** Acepta ambos formatos de difusión: eventos mínimos (delta) o vista completa (full, línea base). */
const isStarted = (matchId: string) => (m: ServerMsg) =>
  (m.type === 'match.update' &&
    m.payload.matchId === matchId &&
    (m.payload.events as { type: string }[]).some((e) => e.type === 'match.started')) ||
  (m.type === 'match.sync' && m.payload.matchId === matchId && (m.payload.view as { status: string }).status === 'active');
const isResolved = (matchId: string, round: number) => (m: ServerMsg) =>
  (m.type === 'match.update' &&
    m.payload.matchId === matchId &&
    (m.payload.events as { type: string; round?: number }[]).some((e) => e.type === 'round.resolved' && e.round === round)) ||
  (m.type === 'match.sync' &&
    m.payload.matchId === matchId &&
    ((m.payload.view as { round: number; status: string }).round > round ||
      (m.payload.view as { status: string }).status !== 'active'));

const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

/** Muestreo de CPU (% de un núcleo) y RSS del proceso del servidor. */
function sampler(pid: string | undefined) {
  if (!pid) return { stop: () => ({ cpuPct: null, rssMb: null }) };
  const ticks = () => {
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ');
    return Number(f[11]) + Number(f[12]);
  };
  const rss = () => Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) / 1024;
  const t0 = ticks();
  const w0 = Date.now();
  const rssSamples: number[] = [];
  const h = setInterval(() => rssSamples.push(rss()), 500);
  return {
    stop: () => {
      clearInterval(h);
      const cpu = ((ticks() - t0) / 100 / ((Date.now() - w0) / 1000)) * 100;
      return { cpuPct: Math.round(cpu), rssMb: Math.round(Math.max(...rssSamples, rss())) };
    },
  };
}

async function setupPlayers(n: number): Promise<GameClient[]> {
  const out: GameClient[] = [];
  const batch = 20;
  for (let i = 0; i < n; i += batch) {
    const group = await Promise.all(
      Array.from({ length: Math.min(batch, n - i) }, async (_, j) => {
        const c = new GameClient(url, `load${Date.now().toString(36)}${i + j}`, { keepLog: false });
        await c.register();
        return c;
      }),
    );
    out.push(...group);
  }
  return out;
}

async function runLevel(nMatches: number, baselineRss: number | null): Promise<LevelResult> {
  const players = await setupPlayers(nMatches * 2);
  for (let i = 0; i < players.length; i += 50) await Promise.all(players.slice(i, i + 50).map((p) => p.connect()));
  let bytes = 0;
  let updates = 0;
  for (const p of players) {
    p.ws!.on('message', (raw: Buffer) => {
      bytes += raw.length;
      updates++;
    });
  }
  // Crear partidas: el primero crea, el segundo se une, ambos se suscriben y marcan listo.
  const games: { id: string; a: GameClient; b: GameClient }[] = [];
  for (let i = 0; i < nMatches; i++) {
    const a = players[2 * i]!;
    const b = players[2 * i + 1]!;
    const { matchId } = await a.http<{ matchId: string }>('POST', '/v1/matches', { visibility: 'public', maxPlayers: 2 });
    await b.http('POST', `/v1/matches/${matchId}/join`);
    games.push({ id: matchId, a, b });
  }
  await Promise.all(games.flatMap((g) => [g.a.subscribe(g.id), g.b.subscribe(g.id)]));
  await Promise.all(
    games.map(async (g) => {
      const started = Promise.all([g.a.waitFor(isStarted(g.id), 30_000), g.b.waitFor(isStarted(g.id), 30_000)]);
      await g.a.request('match.ready', { matchId: g.id, ready: true });
      await g.b.request('match.ready', { matchId: g.id, ready: true });
      await started;
    }),
  );

  const sample = sampler(values.pid);
  const t0 = Date.now();
  const latencies: number[] = [];
  let errors = 0;
  let requests = 0;
  let lost = 0;
  let duplicated = 0;

  await Promise.all(
    games.map(async (g) => {
      for (let r = 1; r <= ROUNDS; r++) {
        const view = g.a.views.get(g.id);
        if (!view || view.status !== 'active') break;
        const round = view.round;
        const waits = [g.a, g.b].map((p) => p.waitFor(isResolved(g.id, round), 15_000));
        // A juega primero; la jugada de B cierra la ronda: se mide desde el envío de B.
        requests += 2;
        const ra = await g.a.act(g.id, round, chooseAction(g.a.views.get(g.id)!));
        if (ra.type === 'error') errors++;
        const sent = performance.now();
        const rb = await g.b.act(g.id, round, chooseAction(g.b.views.get(g.id)!));
        if (rb.type === 'error') errors++;
        const results = await Promise.allSettled(waits.map((w) => w.then(() => performance.now())));
        for (const res of results) {
          if (res.status === 'rejected') lost++;
        }
        const ok = results.filter((x): x is PromiseFulfilledResult<number> => x.status === 'fulfilled').map((x) => x.value);
        if (ok.length === 2) latencies.push(Math.max(...ok) - sent);
      }
    }),
  );
  const durationS = (Date.now() - t0) / 1000;
  const usage = sample.stop();

  // Integridad: cada ronda resuelta llega exactamente una vez a cada jugador.
  for (const g of games) {
    for (const p of [g.a, g.b]) {
      const seen = new Set<number>();
      for (const m of p.received) {
        if (m.type !== 'match.update') continue;
        for (const e of m.payload.events as { type: string; round?: number }[]) {
          if (e.type !== 'round.resolved') continue;
          if (seen.has(e.round!)) duplicated++;
          seen.add(e.round!);
        }
      }
    }
  }
  await Promise.all(games.flatMap((g) => [g.a.http('POST', `/v1/matches/${g.id}/leave`).catch(() => undefined)]));
  await Promise.all(players.map((p) => p.close()));

  const rssMb = usage.rssMb;
  return {
    matches: nMatches,
    connections: players.length,
    rounds: latencies.length,
    p50: Math.round(pct(latencies, 50)),
    p95: Math.round(pct(latencies, 95)),
    p99: Math.round(pct(latencies, 99)),
    max: Math.round(Math.max(0, ...latencies)),
    errors,
    errorRate: requests ? Number(((100 * errors) / requests).toFixed(2)) : 0,
    lost,
    duplicated,
    bytesPerUpdate: updates ? Math.round(bytes / updates) : 0,
    cpuPct: usage.cpuPct,
    rssMb,
    rssPerMatchKb: rssMb && baselineRss ? Math.round(((rssMb - baselineRss) * 1024) / nMatches) : null,
    durationS,
  };
}

async function main(): Promise<void> {
  const baseline = values.pid ? sampler(values.pid).stop().rssMb : null;
  const levels = values.matches.split(',').map(Number);
  const results: LevelResult[] = [];
  console.log(`Prueba de carga contra ${url} — ${ROUNDS} rondas por partida`);
  console.log('partidas | conexiones | rondas | p50 | p95 | p99 | max (ms) | error % | perdidas | duplicadas | bytes/msg | CPU % | RSS MB | KB/partida');
  for (const n of levels) {
    const r = await runLevel(n, baseline);
    results.push(r);
    console.log(
      [r.matches, r.connections, r.rounds, r.p50, r.p95, r.p99, r.max, r.errorRate, r.lost, r.duplicated, r.bytesPerUpdate, r.cpuPct ?? '-', r.rssMb ?? '-', r.rssPerMatchKb ?? '-'].join(' | '),
    );
    if (r.p95 > 200 || r.errorRate > 1 || r.lost > 0) {
      console.log(`>> Punto de quiebre alcanzado en ${n} partidas simultáneas (p95=${r.p95} ms, error=${r.errorRate} %, perdidas=${r.lost})`);
      break;
    }
  }
  mkdirSync('load/results', { recursive: true });
  const file = `load/results/${values.label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify({ url, rounds: ROUNDS, label: values.label, results }, null, 2));
  console.log(`Resultados: ${file}`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
