import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Config } from '../config.js';
import { getAccessToken } from './azure.js';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

const PG_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';

export function createPool(cfg: Config): Db {
  if (cfg.AUTH_MODE === 'azure') {
    // Autenticación Entra con identidad administrada: el "password" es un token de corta duración.
    return new pg.Pool({
      host: cfg.PGHOST,
      database: cfg.PGDATABASE,
      user: cfg.PGUSER,
      port: 5432,
      ssl: { rejectUnauthorized: true },
      max: cfg.PG_POOL_MAX,
      password: async () => (await getAccessToken(cfg, PG_SCOPE)).token,
    });
  }
  if (!cfg.DATABASE_URL) throw new Error('Falta DATABASE_URL');
  return new pg.Pool({ connectionString: cfg.DATABASE_URL, max: cfg.PG_POOL_MAX });
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Aplica migraciones SQL en orden. Un advisory lock evita carreras entre réplicas. */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    client.release();
  }
  return applied;
}
