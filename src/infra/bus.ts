import type { Redis } from 'ioredis';
import type { DomainEvent, MatchState } from '../domain/index.js';

export interface StoredEvent {
  readonly seq: number;
  readonly event: DomainEvent;
}

/** Lo que se difunde entre réplicas tras confirmar un cambio en una partida. */
export interface MatchUpdate {
  readonly matchId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly events: readonly StoredEvent[];
  /** Solo en modo `full` (línea base sin optimizar): estado completo para reconstruir vistas. */
  readonly state?: MatchState;
  /** Marca de tiempo de llegada de la jugada que originó el cambio, para medir latencia. */
  readonly receivedAt?: number;
}

export type UserNotice =
  | { readonly type: 'matchmaking.matched'; readonly matchId: string }
  | { readonly type: 'matchmaking.timeout' }
  | { readonly type: 'kick'; readonly reason: 'suspended' };

type Handler<T> = (msg: T) => void;

/**
 * Difusión de eventos entre réplicas mediante Redis pub/sub.
 * Cada réplica se suscribe solo a los canales de las partidas y usuarios que tiene conectados.
 */
export class EventBus {
  private readonly handlers = new Map<string, Set<Handler<unknown>>>();

  constructor(
    private readonly pub: Redis,
    private readonly sub: Redis,
  ) {
    sub.on('message', (channel: string, raw: string) => {
      const hs = this.handlers.get(channel);
      if (!hs) return;
      let msg: unknown;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      for (const h of hs) h(msg);
    });
  }

  publishMatch(update: MatchUpdate): Promise<number> {
    return this.pub.publish(`match:${update.matchId}`, JSON.stringify(update));
  }

  publishUser(userId: string, notice: UserNotice): Promise<number> {
    return this.pub.publish(`user:${userId}`, JSON.stringify(notice));
  }

  onMatch(matchId: string, h: Handler<MatchUpdate>): Promise<() => Promise<void>> {
    return this.on(`match:${matchId}`, h as Handler<unknown>);
  }

  onUser(userId: string, h: Handler<UserNotice>): Promise<() => Promise<void>> {
    return this.on(`user:${userId}`, h as Handler<unknown>);
  }

  private async on(channel: string, h: Handler<unknown>): Promise<() => Promise<void>> {
    let hs = this.handlers.get(channel);
    if (!hs) {
      hs = new Set();
      this.handlers.set(channel, hs);
      await this.sub.subscribe(channel);
    }
    hs.add(h);
    return async () => {
      const set = this.handlers.get(channel);
      if (!set) return;
      set.delete(h);
      if (set.size === 0) {
        this.handlers.delete(channel);
        await this.sub.unsubscribe(channel);
      }
    };
  }
}
