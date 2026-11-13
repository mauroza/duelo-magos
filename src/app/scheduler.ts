import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { MatchState } from '../domain/index.js';
import type { Db } from '../infra/db.js';
import { tryLeader } from '../infra/redis.js';
import { setActiveMatches } from '../observability/metrics.js';
import type { MatchService } from './match-service.js';

/**
 * Reloj del servidor. Todas las réplicas barren las partidas vencidas; FOR UPDATE SKIP LOCKED
 * reparte el trabajo sin duplicarlo. Los temporizadores sobreviven reinicios porque el
 * vencimiento está guardado en la base de datos, no en memoria.
 */
export class Scheduler {
  private timers: NodeJS.Timeout[] = [];
  private sweeping = false;

  constructor(
    private readonly db: Db,
    private readonly redis: Redis,
    private readonly matches: MatchService,
    private readonly log: Logger,
    private readonly opts: { sweepMs: number; instanceId: string },
  ) {}

  start(): void {
    this.timers.push(setInterval(() => void this.sweep(), this.opts.sweepMs));
    this.timers.push(setInterval(() => void this.reapPresence(), 10_000));
    this.timers.push(
      setInterval(() => {
        void this.matches
          .countActive()
          .then(setActiveMatches)
          .catch(() => undefined);
      }, 15_000),
    );
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const due = await this.matches.dueMatches(100);
      await Promise.all(
        due.map((id) =>
          this.matches.tick(id).catch((err: unknown) => {
            // Aislamiento: el error de una partida no detiene a las demás.
            this.log.error({ err, matchId: id }, 'error al avanzar el reloj de la partida');
          }),
        ),
      );
    } catch (err) {
      this.log.error({ err }, 'error en el barrido de temporizadores');
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Si una réplica muere, sus conexiones no alcanzan a marcar la desconexión. El líder revisa
   * la presencia en Redis (con caducidad) y marca como desconectados a quienes ya no tienen conexión viva.
   */
  async reapPresence(): Promise<void> {
    try {
      if (!(await tryLeader(this.redis, 'presence:leader', this.opts.instanceId, 15_000))) return;
      const { rows } = await this.db.query<{ id: string; state: MatchState }>(
        "SELECT id, state FROM matches WHERE status = 'active'",
      );
      const now = Date.now();
      for (const { id, state } of rows) {
        for (const p of state.players) {
          if (!p.connected || !p.alive) continue;
          const live = await this.redis.zcount(`presence:${id}:${p.id}`, now, '+inf');
          if (live === 0) await this.matches.setPresence(p.id, id, false);
        }
      }
    } catch (err) {
      this.log.error({ err }, 'error al revisar presencia');
    }
  }
}
