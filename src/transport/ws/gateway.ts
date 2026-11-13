import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Logger } from 'pino';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { toAppError } from '../../app/errors.js';
import type { AuthService } from '../../app/auth-service.js';
import type { MatchService } from '../../app/match-service.js';
import { playerView, type DomainEvent } from '../../domain/index.js';
import type { EventBus, MatchUpdate } from '../../infra/bus.js';
import { TokenBucket, type ConnectionRegistry, type PresenceStore, type TicketStore } from '../../infra/redis.js';
import { gameMetrics } from '../../observability/metrics.js';
import { ClientMessage, CloseCodes, PROTOCOL_VERSION, type ServerMessageType } from './protocol.js';

export interface GatewayDeps {
  readonly log: Logger;
  readonly auth: AuthService;
  readonly matches: MatchService;
  readonly bus: EventBus;
  readonly tickets: TicketStore;
  readonly connections: ConnectionRegistry;
  readonly presence: PresenceStore;
  readonly allowedOrigins: string[];
  readonly maxPayloadBytes: number;
  readonly heartbeatMs: number;
  readonly msgPerSec: number;
  readonly msgBurst: number;
  readonly broadcastMode: 'delta' | 'full';
}

interface Conn {
  readonly id: string;
  readonly userId: string;
  readonly ws: WebSocket;
  readonly bucket: TokenBucket;
  readonly log: Logger;
  alive: boolean;
  /** Última secuencia entregada por partida suscrita. */
  readonly matches: Map<string, number>;
  unsubscribeUser?: () => Promise<void>;
}

/**
 * Pasarela WebSocket. Autentica el handshake con un ticket de un solo uso, valida cada mensaje
 * contra su esquema antes de llegar al dominio y entrega a cada jugador solo lo que puede ver.
 */
export class Gateway {
  private readonly wss: WebSocketServer;
  private readonly conns = new Set<Conn>();
  private readonly byMatch = new Map<string, Set<Conn>>();
  private readonly matchUnsubs = new Map<string, Promise<() => Promise<void>>>();
  private heartbeat: NodeJS.Timeout | undefined;
  private accepting = true;

  constructor(private readonly deps: GatewayDeps) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: deps.maxPayloadBytes, perMessageDeflate: false });
  }

  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/v1/ws') {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => void this.onConnection(ws, req, url));
    });
    this.heartbeat = setInterval(() => this.beat(), this.deps.heartbeatMs);
    this.heartbeat.unref();
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  private async onConnection(ws: WebSocket, req: IncomingMessage, url: URL): Promise<void> {
    if (!this.accepting) {
      ws.close(CloseCodes.SERVER_RESTART, 'reconnect');
      return;
    }
    // Orígenes restringidos: un navegador siempre envía Origin; clientes nativos (bot) no.
    const origin = req.headers.origin;
    if (origin && !this.deps.allowedOrigins.includes(origin)) {
      ws.close(CloseCodes.FORBIDDEN_ORIGIN, 'origin not allowed');
      return;
    }
    const userId = await this.deps.tickets.consume(url.searchParams.get('ticket') ?? '').catch(() => null);
    if (!userId) {
      ws.close(CloseCodes.UNAUTHORIZED, 'invalid or expired ticket');
      return;
    }
    if (await this.deps.auth.isSuspended(userId)) {
      ws.close(CloseCodes.SUSPENDED, 'suspended');
      return;
    }
    const connId = randomUUID();
    if (!(await this.deps.connections.add(userId, connId, this.deps.heartbeatMs * 3))) {
      ws.close(CloseCodes.TOO_MANY_CONNECTIONS, 'too many connections');
      return;
    }
    const conn: Conn = {
      id: connId,
      userId,
      ws,
      bucket: new TokenBucket(this.deps.msgPerSec, this.deps.msgBurst),
      log: this.deps.log.child({ userId, connId }),
      alive: true,
      matches: new Map(),
    };
    this.conns.add(conn);
    gameMetrics.wsConnections.add(1);
    conn.unsubscribeUser = await this.deps.bus.onUser(userId, (notice) => {
      if (notice.type === 'kick') {
        ws.close(CloseCodes.SUSPENDED, 'suspended');
        return;
      }
      this.send(conn, notice.type, notice.type === 'matchmaking.matched' ? { matchId: notice.matchId } : {});
    });

    ws.on('pong', () => {
      conn.alive = true;
      void this.touch(conn);
    });
    ws.on('message', (data: RawData, isBinary: boolean) => void this.onMessage(conn, data, isBinary));
    ws.on('close', () => void this.onClose(conn));
    ws.on('error', (err) => conn.log.warn({ err }, 'error de socket'));

    this.send(conn, 'welcome', {
      userId,
      protocolVersion: PROTOCOL_VERSION,
      heartbeatMs: this.deps.heartbeatMs,
    });
    conn.log.info('conexión WebSocket abierta');
  }

  private async onMessage(conn: Conn, data: RawData, isBinary: boolean): Promise<void> {
    if (!conn.bucket.take()) {
      gameMetrics.rateLimited.add(1, { transport: 'ws' });
      this.sendError(conn, undefined, 'RATE_LIMITED', 'Demasiados mensajes; reduzca la frecuencia');
      return;
    }
    if (isBinary) {
      this.sendError(conn, undefined, 'VALIDATION_FAILED', 'Solo se aceptan mensajes de texto JSON');
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(rawToString(data));
    } catch {
      this.sendError(conn, undefined, 'VALIDATION_FAILED', 'JSON inválido');
      return;
    }
    const v = (json as { v?: unknown } | null)?.v;
    if (v !== undefined && v !== PROTOCOL_VERSION) {
      this.sendError(conn, undefined, 'UNSUPPORTED_VERSION', `Versión de protocolo no soportada: ${JSON.stringify(v)}`);
      return;
    }
    const parsed = ClientMessage.safeParse(json);
    if (!parsed.success) {
      // Un mensaje inválido se rechaza sin cerrar la conexión ni afectar la partida.
      const id = typeof (json as { id?: unknown } | null)?.id === 'string' ? (json as { id: string }).id : undefined;
      this.sendError(conn, id, 'VALIDATION_FAILED', 'El mensaje no cumple el esquema', {
        errors: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }
    const msg = parsed.data;
    const receivedAt = Date.now();
    try {
      switch (msg.type) {
        case 'ping':
          this.send(conn, 'pong', {}, msg.id);
          return;
        case 'match.subscribe':
          await this.subscribe(conn, msg.payload.matchId, msg.id);
          return;
        case 'match.unsubscribe':
          await this.unsubscribe(conn, msg.payload.matchId);
          this.send(conn, 'ack', { ok: true }, msg.id);
          return;
        case 'match.ready':
          await this.deps.matches.setReady(conn.userId, msg.payload.matchId, msg.payload.ready);
          this.send(conn, 'ack', { ok: true }, msg.id);
          return;
        case 'action.submit': {
          const p = msg.payload;
          const res = await this.deps.matches.submitAction(conn.userId, p.matchId, p.clientMoveId, p.round, p.action, receivedAt);
          this.send(conn, 'ack', { ok: true, duplicate: res.duplicate, seq: res.seq }, msg.id);
          return;
        }
      }
    } catch (err) {
      const e = toAppError(err);
      if (e.status >= 500) conn.log.error({ err }, 'error procesando mensaje');
      this.sendError(conn, msg.id, e.code, e.message);
    }
  }

  private async subscribe(conn: Conn, matchId: string, msgId?: string): Promise<void> {
    const { view, seq } = await this.deps.matches.getView(matchId, conn.userId);
    let set = this.byMatch.get(matchId);
    if (!set) {
      set = new Set();
      this.byMatch.set(matchId, set);
      this.matchUnsubs.set(matchId, this.deps.bus.onMatch(matchId, (u) => void this.deliver(u)));
    }
    await this.matchUnsubs.get(matchId);
    set.add(conn);
    conn.matches.set(matchId, seq);
    await this.deps.presence.add(matchId, conn.userId, conn.id, this.deps.heartbeatMs * 3);
    this.send(conn, 'match.sync', { matchId, seq, view }, msgId);
    if (!view.players.find((p) => p.id === conn.userId)?.connected) {
      await this.deps.matches.setPresence(conn.userId, matchId, true);
    }
  }

  private async unsubscribe(conn: Conn, matchId: string): Promise<void> {
    if (!conn.matches.delete(matchId)) return;
    const set = this.byMatch.get(matchId);
    set?.delete(conn);
    if (set && set.size === 0) {
      this.byMatch.delete(matchId);
      const unsub = this.matchUnsubs.get(matchId);
      this.matchUnsubs.delete(matchId);
      await (await unsub)?.();
    }
    const remaining = await this.deps.presence.remove(matchId, conn.userId, conn.id);
    if (remaining === 0) await this.deps.matches.setPresence(conn.userId, matchId, false).catch(() => undefined);
  }

  /** Entrega una actualización a las conexiones locales de esa partida, filtrada por jugador. */
  private async deliver(update: MatchUpdate): Promise<void> {
    const set = this.byMatch.get(update.matchId);
    if (!set) return;
    for (const conn of set) {
      const last = conn.matches.get(update.matchId) ?? 0;
      if (update.toSeq <= last) continue; // ya cubierto por una sincronización
      if (update.fromSeq > last + 1 || (this.deps.broadcastMode === 'full' && update.state)) {
        // Hueco (difusión desordenada entre réplicas) o modo full: se envía la vista completa.
        const { view, seq } =
          update.state && update.fromSeq <= last + 1
            ? { view: playerView(update.state, conn.userId), seq: update.toSeq }
            : await this.deps.matches.getView(update.matchId, conn.userId);
        conn.matches.set(update.matchId, seq);
        this.send(conn, 'match.sync', { matchId: update.matchId, seq, view });
        continue;
      }
      const events = update.events
        .filter(({ event }) => event.to === 'all' || event.to === conn.userId)
        .map(({ seq, event }) => ({ seq, ...stripRecipient(event) }));
      conn.matches.set(update.matchId, update.toSeq);
      this.send(conn, 'match.update', {
        matchId: update.matchId,
        fromSeq: update.fromSeq,
        toSeq: update.toSeq,
        events,
      });
    }
    if (update.receivedAt) gameMetrics.actionLatency.record(Date.now() - update.receivedAt, { stage: 'broadcast' });
  }

  private async onClose(conn: Conn): Promise<void> {
    if (!this.conns.delete(conn)) return;
    gameMetrics.wsConnections.add(-1);
    await conn.unsubscribeUser?.().catch(() => undefined);
    for (const matchId of [...conn.matches.keys()]) {
      await this.unsubscribe(conn, matchId).catch((err: unknown) => conn.log.warn({ err }, 'error al desuscribir'));
    }
    await this.deps.connections.remove(conn.userId, conn.id).catch(() => undefined);
    conn.log.info('conexión WebSocket cerrada');
  }

  private async touch(conn: Conn): Promise<void> {
    const ttl = this.deps.heartbeatMs * 3;
    await this.deps.connections.touch(conn.userId, conn.id, ttl).catch(() => undefined);
    for (const matchId of conn.matches.keys()) {
      await this.deps.presence.add(matchId, conn.userId, conn.id, ttl).catch(() => undefined);
    }
  }

  /** Heartbeat ping/pong: quien no responde a tiempo se desconecta y entra en periodo de gracia. */
  private beat(): void {
    for (const conn of this.conns) {
      if (!conn.alive) {
        conn.ws.close(CloseCodes.HEARTBEAT_TIMEOUT, 'heartbeat timeout');
        setTimeout(() => conn.ws.terminate(), 2000).unref();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
  }

  private send(conn: Conn, type: ServerMessageType, payload: object, replyTo?: string): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    conn.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type, ...(replyTo ? { replyTo } : {}), payload }));
  }

  private sendError(conn: Conn, replyTo: string | undefined, code: string, message: string, extra: object = {}): void {
    this.send(conn, 'error', { code, message, ...extra }, replyTo);
  }

  /** Cierre ordenado: avisa a los clientes que reconecten (a otra réplica o revisión). */
  async shutdown(drainMs: number): Promise<void> {
    this.accepting = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const conn of this.conns) conn.ws.close(CloseCodes.SERVER_RESTART, 'server restarting, please reconnect');
    const deadline = Date.now() + drainMs;
    while (this.conns.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    for (const conn of this.conns) conn.ws.terminate();
    this.wss.close();
  }
}

function stripRecipient(event: DomainEvent): Omit<DomainEvent, 'to'> {
  return Object.fromEntries(Object.entries(event).filter(([k]) => k !== 'to')) as Omit<DomainEvent, 'to'>;
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
