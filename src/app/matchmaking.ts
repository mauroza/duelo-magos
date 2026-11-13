import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { EventBus } from '../infra/bus.js';
import { tryLeader } from '../infra/redis.js';
import { AppError } from './errors.js';
import type { MatchService } from './match-service.js';

const QUEUE = 'mm:queue';
const NAMES = 'mm:names';

/** Saca atómicamente hasta N jugadores de la cola (los más antiguos). */
const POP_SCRIPT = `
local n = tonumber(ARGV[1])
if redis.call('ZCARD', KEYS[1]) < n then return {} end
local items = redis.call('ZPOPMIN', KEYS[1], n)
local out = {}
for i = 1, #items, 2 do
  local name = redis.call('HGET', KEYS[2], items[i]) or ''
  redis.call('HDEL', KEYS[2], items[i])
  table.insert(out, items[i]); table.insert(out, name)
end
return out`;

/**
 * Cola rápida. Solo una réplica (el líder, elegido con un lock en Redis) forma partidas, y la
 * extracción de la cola es atómica: un jugador nunca queda asignado a dos partidas.
 */
export class Matchmaker {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly redis: Redis,
    private readonly matches: MatchService,
    private readonly bus: EventBus,
    private readonly log: Logger,
    private readonly opts: { groupSize: number; maxWaitMs: number; instanceId: string },
  ) {}

  async enqueue(user: { id: string; name: string }): Promise<{ queued: boolean; position: number; maxWaitMs: number }> {
    if (await this.matches.activeMatchOf(user.id)) {
      throw new AppError(409, 'ALREADY_IN_MATCH', 'Ya estás en una partida activa');
    }
    await this.redis.multi().zadd(QUEUE, 'NX', Date.now(), user.id).hset(NAMES, user.id, user.name).exec();
    const rank = await this.redis.zrank(QUEUE, user.id);
    return { queued: true, position: (rank ?? 0) + 1, maxWaitMs: this.opts.maxWaitMs };
  }

  async dequeue(userId: string): Promise<void> {
    await this.redis.multi().zrem(QUEUE, userId).hdel(NAMES, userId).exec();
  }

  start(intervalMs = 500): void {
    this.timer = setInterval(() => {
      void this.runOnce().catch((err: unknown) => this.log.error({ err }, 'error en emparejamiento'));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<number> {
    if (!(await tryLeader(this.redis, 'mm:leader', this.opts.instanceId, 3000))) return 0;
    // Expira a quienes superaron el tiempo máximo de espera configurable.
    const expired = await this.redis.zrangebyscore(QUEUE, 0, Date.now() - this.opts.maxWaitMs);
    for (const userId of expired) {
      await this.dequeue(userId);
      await this.bus.publishUser(userId, { type: 'matchmaking.timeout' });
    }
    let formed = 0;
    for (;;) {
      const raw = (await this.redis.eval(POP_SCRIPT, 2, QUEUE, NAMES, this.opts.groupSize)) as string[];
      if (raw.length === 0) break;
      const players: { id: string; name: string }[] = [];
      for (let i = 0; i < raw.length; i += 2) players.push({ id: raw[i] ?? '', name: raw[i + 1] || 'Mago' });
      try {
        const { matchId, skipped } = await this.matches.createMatchmade(players);
        formed++;
        for (const p of players) {
          if (!skipped.includes(p.id)) await this.bus.publishUser(p.id, { type: 'matchmaking.matched', matchId });
        }
        this.log.info({ matchId, players: players.map((p) => p.id) }, 'partida emparejada');
      } catch (err) {
        // Si alguno ya estaba en otra partida, los demás vuelven a la cola con su antigüedad.
        for (const p of players) {
          if (!(await this.matches.activeMatchOf(p.id))) {
            await this.redis.multi().zadd(QUEUE, 'NX', Date.now(), p.id).hset(NAMES, p.id, p.name).exec();
          }
        }
        this.log.warn({ err }, 'emparejamiento reintentado');
        break;
      }
    }
    return formed;
  }
}
