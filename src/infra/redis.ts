import { randomBytes } from 'node:crypto';
import { Redis, type RedisOptions } from 'ioredis';
import type { Config } from '../config.js';
import { getAccessToken } from './azure.js';

const REDIS_SCOPE = 'https://redis.azure.com/.default';

export interface RedisClients {
  /** Comandos normales. */
  readonly cmd: Redis;
  /** Conexión dedicada a suscripciones pub/sub. */
  readonly sub: Redis;
  close(): Promise<void>;
}

export async function createRedis(cfg: Config): Promise<RedisClients> {
  let options: RedisOptions = { maxRetriesPerRequest: 3, enableAutoPipelining: true, lazyConnect: true };
  let refresh: NodeJS.Timeout | undefined;

  if (cfg.AUTH_MODE === 'azure' && cfg.REDIS_AUTH === 'password') {
    // Redis privado dentro de la VNet del entorno; contraseña desde Key Vault vía secreto de Container Apps.
    if (!cfg.REDIS_PASSWORD) throw new Error('Falta REDIS_PASSWORD (secreto de Key Vault)');
    options = {
      ...options,
      host: cfg.REDIS_HOST,
      port: cfg.REDIS_PORT,
      password: cfg.REDIS_PASSWORD,
      ...(cfg.REDIS_TLS ? { tls: { servername: cfg.REDIS_HOST } } : {}),
    };
  } else if (cfg.AUTH_MODE === 'azure') {
    // Autenticación Entra: usuario = object id de la identidad, contraseña = token de corta duración.
    const { token } = await getAccessToken(cfg, REDIS_SCOPE);
    options = {
      ...options,
      host: cfg.REDIS_HOST,
      port: cfg.REDIS_PORT,
      tls: { servername: cfg.REDIS_HOST },
      username: cfg.REDIS_USERNAME,
      password: token,
    };
  }
  const make = (): Redis =>
    cfg.AUTH_MODE === 'azure' ? new Redis(options) : new Redis(cfg.REDIS_URL ?? 'redis://localhost:6379', options);

  const cmd = make();
  const sub = make();
  await Promise.all([cmd.connect(), sub.connect()]);

  if (cfg.AUTH_MODE === 'azure' && cfg.REDIS_AUTH === 'entra') {
    // Los tokens duran ~1 h: se renueva la autenticación cada 30 min en ambas conexiones.
    refresh = setInterval(() => {
      void (async () => {
        const { token } = await getAccessToken(cfg, REDIS_SCOPE);
        for (const c of [cmd, sub]) {
          c.options.password = token;
          await c.call('AUTH', cfg.REDIS_USERNAME ?? '', token);
        }
      })().catch(() => undefined);
    }, 30 * 60_000);
    refresh.unref();
  }

  return {
    cmd,
    sub,
    async close() {
      if (refresh) clearInterval(refresh);
      await Promise.allSettled([cmd.quit(), sub.quit()]);
    },
  };
}

/** Tickets de un solo uso y corta duración para autenticar el handshake WebSocket. */
export class TicketStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
  ) {}

  async issue(userId: string): Promise<{ ticket: string; expiresIn: number }> {
    const ticket = randomBytes(32).toString('base64url');
    await this.redis.set(`wsticket:${ticket}`, userId, 'EX', this.ttlSeconds);
    return { ticket, expiresIn: this.ttlSeconds };
  }

  /** GETDEL garantiza que el ticket se consume una sola vez, aunque dos réplicas lo reciban a la vez. */
  async consume(ticket: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(ticket)) return null;
    return this.redis.getdel(`wsticket:${ticket}`);
  }
}

/** Límite de conexiones simultáneas por usuario, compartido entre réplicas. */
export class ConnectionRegistry {
  constructor(
    private readonly redis: Redis,
    private readonly maxPerUser: number,
  ) {}

  private key(userId: string): string {
    return `conns:${userId}`;
  }

  /** Registra la conexión con caducidad; devuelve false si se supera el máximo. */
  async add(userId: string, connId: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const key = this.key(userId);
    const res = await this.redis
      .multi()
      .zremrangebyscore(key, 0, now)
      .zadd(key, now + ttlMs, connId)
      .zcard(key)
      .pexpire(key, ttlMs)
      .exec();
    const count = Number(res?.[2]?.[1] ?? 0);
    if (count > this.maxPerUser) {
      await this.redis.zrem(key, connId);
      return false;
    }
    return true;
  }

  async touch(userId: string, connId: string, ttlMs: number): Promise<void> {
    await this.redis.multi().zadd(this.key(userId), Date.now() + ttlMs, connId).pexpire(this.key(userId), ttlMs).exec();
  }

  async remove(userId: string, connId: string): Promise<void> {
    await this.redis.zrem(this.key(userId), connId);
  }

  async count(userId: string): Promise<number> {
    return this.redis.zcount(this.key(userId), Date.now(), '+inf');
  }

  /** Conexiones vivas en todo el sistema (para administración). */
  async snapshot(): Promise<{ userId: string; connections: number }[]> {
    const out: { userId: string; connections: number }[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', 'conns:*', 'COUNT', 200);
      cursor = next;
      for (const k of keys) {
        const n = await this.redis.zcount(k, Date.now(), '+inf');
        if (n > 0) out.push({ userId: k.slice('conns:'.length), connections: n });
      }
    } while (cursor !== '0');
    return out;
  }
}

/**
 * Presencia de un jugador en una partida, compartida entre réplicas.
 * Un jugador puede tener varias conexiones; solo se considera desconectado si no queda ninguna viva.
 */
export class PresenceStore {
  constructor(private readonly redis: Redis) {}

  private key(matchId: string, userId: string): string {
    return `presence:${matchId}:${userId}`;
  }

  async add(matchId: string, userId: string, connId: string, ttlMs: number): Promise<void> {
    const key = this.key(matchId, userId);
    await this.redis.multi().zadd(key, Date.now() + ttlMs, connId).pexpire(key, ttlMs).exec();
  }

  /** Quita la conexión y devuelve cuántas siguen vivas. */
  async remove(matchId: string, userId: string, connId: string): Promise<number> {
    const key = this.key(matchId, userId);
    const res = await this.redis.multi().zrem(key, connId).zremrangebyscore(key, 0, Date.now()).zcard(key).exec();
    return Number(res?.[2]?.[1] ?? 0);
  }
}

/** Token bucket en memoria para mensajes WebSocket de una conexión. */
export class TokenBucket {
  private tokens: number;
  private last = Date.now();

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }

  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSec);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Lock distribuido simple (líder del emparejamiento). */
export async function tryLeader(redis: Redis, key: string, owner: string, ttlMs: number): Promise<boolean> {
  const ok = await redis.set(key, owner, 'PX', ttlMs, 'NX');
  if (ok === 'OK') return true;
  const current = await redis.get(key);
  if (current === owner) {
    await redis.pexpire(key, ttlMs);
    return true;
  }
  return false;
}
