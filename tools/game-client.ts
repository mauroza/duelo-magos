/**
 * Cliente de prueba en TypeScript. Lo usan el bot, las pruebas de integración y la prueba de carga.
 * Habla exactamente el protocolo de contracts/openapi.yaml y contracts/asyncapi.yaml.
 */
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

export type Element = 'fuego' | 'agua' | 'tierra';
export type Action =
  | { kind: 'attack'; element: Element; target: string }
  | { kind: 'shield' }
  | { kind: 'channel' };

export interface ViewPlayer {
  id: string;
  name: string;
  hp: number;
  mana: number;
  alive: boolean;
  connected: boolean;
  ready: boolean;
  hasActed: boolean;
}
export interface View {
  matchId: string;
  status: 'lobby' | 'active' | 'finished' | 'aborted';
  round: number;
  roundDeadline: number | null;
  players: ViewPlayer[];
  you: { id: string; affinity: Element | null; pendingAction: Action | null; shieldAvailable: boolean } | null;
  result: { winners: string[]; draw: boolean; reason: string } | null;
  affinities: Record<string, Element> | null;
}
export interface ServerMsg {
  v: 1;
  type: string;
  replyTo?: string;
  payload: Record<string, unknown>;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: { code?: string; detail?: string } & Record<string, unknown>,
    readonly headers: Headers,
  ) {
    super(`${status} ${body.code ?? ''} ${body.detail ?? ''}`);
  }
}

export class GameClient {
  accessToken = '';
  refreshToken = '';
  userId = '';
  ws: WebSocket | null = null;
  readonly received: ServerMsg[] = [];
  readonly views = new Map<string, View>();
  readonly seqs = new Map<string, number>();
  closeCode: number | null = null;
  private listeners = new Set<(m: ServerMsg) => void>();
  private msgCounter = 0;

  constructor(
    readonly baseUrl: string,
    readonly name = `mago${Math.floor(Math.random() * 1e9)}`,
    readonly opts: { origin?: string; keepLog?: boolean } = {},
  ) {}

  async http<T = unknown>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth && this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) throw new HttpError(res.status, (json ?? {}) as HttpError['body'], res.headers);
    return json as T;
  }

  async register(password = 'contraseña-segura-123'): Promise<this> {
    const r = await this.http<{ user: { id: string }; accessToken: string; refreshToken: string }>(
      'POST',
      '/v1/auth/register',
      { username: this.name, password, displayName: this.name.slice(0, 32) },
      false,
    );
    this.accessToken = r.accessToken;
    this.refreshToken = r.refreshToken;
    this.userId = r.user.id;
    return this;
  }

  async login(password = 'contraseña-segura-123'): Promise<this> {
    const r = await this.http<{ user: { id: string }; accessToken: string; refreshToken: string }>(
      'POST',
      '/v1/auth/login',
      { username: this.name, password },
      false,
    );
    this.accessToken = r.accessToken;
    this.refreshToken = r.refreshToken;
    this.userId = r.user.id;
    return this;
  }

  /** Abre el WebSocket con un ticket de un solo uso. */
  async connect(ticketOverride?: string): Promise<this> {
    const ticket =
      ticketOverride ?? (await this.http<{ ticket: string }>('POST', '/v1/realtime/ticket')).ticket;
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + `/v1/ws?ticket=${encodeURIComponent(ticket)}`;
    const ws = new WebSocket(wsUrl, this.opts.origin ? { origin: this.opts.origin } : {});
    this.ws = ws;
    this.closeCode = null;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMsg;
      this.onMessage(msg);
    });
    ws.on('close', (code) => {
      this.closeCode = code;
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout de conexión')), 10_000);
      const done = (fn: () => void) => () => {
        clearTimeout(t);
        fn();
      };
      ws.once('error', (e) => done(() => reject(e))());
      ws.once('close', (code) => done(() => reject(new Error(`cerrado ${code}`)))());
      this.waitFor((m) => m.type === 'welcome', 10_000).then(done(resolve), done(() => reject(new Error('sin welcome'))));
    });
    return this;
  }

  private onMessage(msg: ServerMsg): void {
    if (this.opts.keepLog !== false) this.received.push(msg);
    if (msg.type === 'match.sync') {
      const p = msg.payload as { matchId: string; seq: number; view: View };
      this.views.set(p.matchId, p.view);
      this.seqs.set(p.matchId, p.seq);
    } else if (msg.type === 'match.update') {
      const p = msg.payload as { matchId: string; fromSeq: number; toSeq: number; events: { type: string }[] };
      const last = this.seqs.get(p.matchId) ?? 0;
      if (p.fromSeq > last + 1) {
        // hueco: resincronizar
        this.send('match.subscribe', { matchId: p.matchId });
      } else if (p.toSeq > last) {
        this.seqs.set(p.matchId, p.toSeq);
        this.applyEvents(p.matchId, p.events as unknown as Record<string, unknown>[]);
      }
    }
    for (const l of this.listeners) l(msg);
  }

  /** Mantiene una vista local a partir de los eventos mínimos. */
  private applyEvents(matchId: string, events: Record<string, unknown>[]): void {
    const view = this.views.get(matchId);
    if (!view) return;
    for (const e of events) {
      switch (e.type) {
        case 'lobby.updated':
          view.players = (e.players as ViewPlayer[]).map((p) => ({
            ...{ hp: 0, mana: 0, alive: true, connected: true, hasActed: false },
            ...view.players.find((x) => x.id === p.id),
            ...p,
          }));
          break;
        case 'match.started':
          view.status = 'active';
          view.round = e.round as number;
          view.roundDeadline = e.deadline as number;
          view.players = (e.players as ViewPlayer[]).map((p) => ({ ...p, ready: true, hasActed: false }));
          break;
        case 'affinity.assigned':
          if (view.you) view.you.affinity = e.affinity as Element;
          break;
        case 'action.accepted': {
          const p = view.players.find((x) => x.id === e.playerId);
          if (p) p.hasActed = true;
          break;
        }
        case 'round.resolved': {
          for (const o of e.outcomes as { playerId: string; hp: number; mana: number; alive: boolean; action: Action }[]) {
            const p = view.players.find((x) => x.id === o.playerId);
            if (p) Object.assign(p, { hp: o.hp, mana: o.mana, alive: o.alive });
            if (view.you && o.playerId === view.you.id) view.you.shieldAvailable = o.action.kind !== 'shield';
          }
          for (const p of view.players) p.hasActed = false;
          if (view.you) view.you.pendingAction = null;
          view.round = (e.round as number) + 1;
          view.roundDeadline = e.nextDeadline as number | null;
          break;
        }
        case 'player.presence': {
          const p = view.players.find((x) => x.id === e.playerId);
          if (p) p.connected = e.connected as boolean;
          break;
        }
        case 'player.abandoned': {
          const p = view.players.find((x) => x.id === e.playerId);
          if (p) Object.assign(p, { alive: false, hp: 0 });
          break;
        }
        case 'match.ended':
          view.status = 'finished';
          view.result = e.result as View['result'];
          view.affinities = e.affinities as Record<string, Element>;
          break;
        case 'match.expired':
          view.status = 'aborted';
          break;
      }
    }
  }

  send(type: string, payload: object, id = `c${++this.msgCounter}`): string {
    this.ws?.send(JSON.stringify({ v: 1, type, id, payload }));
    return id;
  }

  sendRaw(data: string): void {
    this.ws?.send(data);
  }

  /** Envía y espera ack o error con el mismo id. */
  async request(type: string, payload: object, timeoutMs = 10_000): Promise<ServerMsg> {
    const id = `c${++this.msgCounter}`;
    const p = this.waitFor((m) => m.replyTo === id && ['ack', 'error', 'match.sync', 'pong'].includes(m.type), timeoutMs);
    this.send(type, payload, id);
    return p;
  }

  async subscribe(matchId: string): Promise<View> {
    const r = await this.request('match.subscribe', { matchId });
    if (r.type === 'error') throw new Error(`subscribe: ${JSON.stringify(r.payload)}`);
    return (r.payload as { view: View }).view;
  }

  async act(matchId: string, round: number, action: Action, clientMoveId = randomUUID()): Promise<ServerMsg> {
    return this.request('action.submit', { matchId, clientMoveId, round, action });
  }

  waitFor(pred: (m: ServerMsg) => boolean, timeoutMs = 10_000): Promise<ServerMsg> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.listeners.delete(l);
        reject(new Error(`timeout esperando mensaje (${this.name})`));
      }, timeoutMs);
      const l = (m: ServerMsg) => {
        if (pred(m)) {
          clearTimeout(t);
          this.listeners.delete(l);
          resolve(m);
        }
      };
      this.listeners.add(l);
    });
  }

  /** Espera un evento de dominio concreto dentro de match.update. */
  waitForEvent(matchId: string, type: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    return this.waitFor(
      (m) =>
        m.type === 'match.update' &&
        (m.payload as { matchId: string }).matchId === matchId &&
        (m.payload as { events: { type: string }[] }).events.some((e) => e.type === type),
      timeoutMs,
    ).then((m) => (m.payload as { events: Record<string, unknown>[] }).events.find((e) => e.type === type)!);
  }

  onAny(l: (m: ServerMsg) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async close(): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      ws.close(1000);
      setTimeout(resolve, 2000).unref();
    });
  }
}

/** Estrategia simple del bot: contraataca, se protege cuando le conviene y canaliza sin maná. */
export function chooseAction(view: View): Action {
  const me = view.players.find((p) => p.id === view.you?.id);
  const foes = view.players.filter((p) => p.alive && p.id !== me?.id);
  const target = foes.sort((a, b) => a.hp - b.hp)[0];
  if (!me || !target || me.mana <= 0) return { kind: 'channel' };
  const affinity = view.you?.affinity ?? 'fuego';
  if (me.hp <= 4 && view.you?.shieldAvailable && Math.random() < 0.5) return { kind: 'shield' };
  const elements: Element[] = ['fuego', 'agua', 'tierra'];
  const element = Math.random() < 0.6 ? affinity : elements[Math.floor(Math.random() * 3)]!;
  return { kind: 'attack', element, target: target.id };
}
