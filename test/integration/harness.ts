import pg from 'pg';
import { Redis } from 'ioredis';
import { loadConfig } from '../../src/config.js';
import { createApp } from '../../src/main.js';
import { GameClient } from '../../tools/game-client.js';

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? 'postgres://duelo:duelo-local-dev@localhost:5432/duelo';
const TEST_DB = process.env.TEST_PG_DB ?? 'duelo_test';
export const DATABASE_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB}`);
export const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';

type App = Awaited<ReturnType<typeof createApp>>;
export interface Replica {
  app: App;
  url: string;
}

/** Base de datos y Redis limpios para cada archivo de pruebas. */
export async function resetInfra(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  await db.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await db.end();
  const redis = new Redis(REDIS_URL);
  await redis.flushdb();
  await redis.quit();
}

export async function startReplica(id: string, env: Record<string, string> = {}): Promise<Replica> {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    INSTANCE_ID: id,
    DATABASE_URL,
    REDIS_URL,
    JWT_SECRET: 'secreto-de-pruebas-de-al-menos-32-caracteres',
    ALLOWED_ORIGINS: 'http://localhost:8080',
    ROUND_MS: '60000',
    GRACE_MS: '60000',
    WS_HEARTBEAT_MS: '1000',
    SWEEP_INTERVAL_MS: '100',
    SHUTDOWN_DRAIN_MS: '500',
    RATE_LIMIT_HTTP_PER_MIN: '10000',
    RATE_LIMIT_AUTH_PER_MIN: '10000',
    ...env,
  });
  const app = await createApp(cfg);
  const address = await app.start(0, '127.0.0.1');
  return { app, url: address };
}

let counter = 0;
export async function newPlayer(url: string, prefix = 'p'): Promise<GameClient> {
  counter++;
  const c = new GameClient(url, `${prefix}${counter}_${Math.floor(Math.random() * 1e6)}`);
  await c.register();
  await c.connect();
  return c;
}

/** Crea una sala con N jugadores conectados y suscritos, y la inicia. */
export async function startedMatch(urls: string[], n = 2): Promise<{ matchId: string; players: GameClient[] }> {
  const players: GameClient[] = [];
  for (let i = 0; i < n; i++) players.push(await newPlayer(urls[i % urls.length]!));
  const host = players[0]!;
  const { matchId } = await host.http<{ matchId: string }>('POST', '/v1/matches', { visibility: 'public', maxPlayers: n });
  for (const p of players.slice(1)) await p.http('POST', `/v1/matches/${matchId}/join`);
  for (const p of players) await p.subscribe(matchId);
  const started = Promise.all(players.map((p) => p.waitForEvent(matchId, 'match.started')));
  for (const p of players) await p.request('match.ready', { matchId, ready: true });
  await started;
  return { matchId, players };
}

export async function makeAdmin(userId: string): Promise<void> {
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [userId]);
  await db.end();
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
