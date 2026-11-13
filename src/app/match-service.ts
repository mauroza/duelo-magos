import { randomInt, randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import {
  createMatch,
  DomainError,
  join as domainJoin,
  leave as domainLeave,
  nextDeadline,
  playerView,
  setPresence as domainSetPresence,
  setReady as domainSetReady,
  start as domainStart,
  submitAction as domainSubmit,
  terminate as domainTerminate,
  tick as domainTick,
  type Action,
  type DomainEvent,
  type MatchConfig,
  type MatchState,
  type PlayerView,
  type RandomSource,
  type Transition,
} from '../domain/index.js';
import type { EventBus, MatchUpdate, StoredEvent } from '../infra/bus.js';
import { withTx, type Db, type Tx } from '../infra/db.js';
import { gameMetrics } from '../observability/metrics.js';
import { AppError } from './errors.js';

/** Azar criptográficamente seguro del servidor. */
export const cryptoRandom: RandomSource = { int: (max) => randomInt(max) };

export interface Player {
  readonly id: string;
  readonly name: string;
}

export interface MatchSummary {
  readonly id: string;
  readonly visibility: 'public' | 'private';
  readonly status: string;
  readonly hostName: string;
  readonly players: number;
  readonly maxPlayers: number;
  readonly createdAt: string;
}

interface MatchRow {
  id: string;
  state: MatchState;
  version: number;
  status: MatchState['status'];
  visibility: 'public' | 'private';
  invite_code: string | null;
}

interface MutateOptions {
  /** Para el barrido de temporizadores: si otra réplica tiene la fila bloqueada, se omite. */
  readonly skipLocked?: boolean;
  readonly receivedAt?: number;
  /** Trabajo adicional dentro de la misma transacción (membresías, idempotencia). */
  readonly before?: (tx: Tx, row: MatchRow) => Promise<void>;
  readonly after?: (tx: Tx, t: Transition, firstSeq: number) => Promise<void>;
  /**
   * Ruta rápida de las jugadas: la comprobación de idempotencia viaja en el mismo SELECT ... FOR UPDATE
   * y el registro de la jugada en la misma sentencia de escritura (4 viajes a la base en vez de 7).
   */
  readonly move?: { readonly userId: string; readonly clientMoveId: string; readonly round: number; readonly action: Action };
}

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class MatchService {
  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly config: MatchConfig,
    private readonly log: Logger,
    private readonly broadcastMode: 'delta' | 'full',
    private readonly rng: RandomSource = cryptoRandom,
    private readonly now: () => number = Date.now,
  ) {}

  // ───────────────────────────── salas ─────────────────────────────

  async createRoom(
    host: Player,
    visibility: 'public' | 'private',
    maxPlayers?: number,
  ): Promise<{ matchId: string; inviteCode: string | null; view: PlayerView }> {
    const id = randomUUID();
    const config = { ...this.config, maxPlayers: maxPlayers ?? this.config.maxPlayers };
    const t = createMatch({ id, host, config, now: this.now() });
    const inviteCode = visibility === 'private' ? this.newInviteCode() : null;
    await withTx(this.db, async (tx) => {
      await this.claimMembership(tx, host.id, id, async () => {
        await tx.query(
          `INSERT INTO matches (id, visibility, invite_code, status, state, version, deadline, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0), $8)`,
          [id, visibility, inviteCode, t.state.status, t.state, t.events.length, nextDeadline(t.state), host.id],
        );
      });
      await tx.query('INSERT INTO match_players (match_id, user_id) VALUES ($1, $2)', [id, host.id]);
      await this.insertEvents(tx, id, 1, t.events);
    });
    this.log.info({ matchId: id, userId: host.id, visibility }, 'sala creada');
    return { matchId: id, inviteCode, view: playerView(t.state, host.id) };
  }

  async listOpen(limit: number, before?: string): Promise<{ items: MatchSummary[]; nextCursor: string | null }> {
    const { rows } = await this.db.query<{
      id: string;
      visibility: 'public' | 'private';
      status: string;
      state: MatchState;
      created_at: Date;
    }>(
      `SELECT id, visibility, status, state, created_at FROM matches
       WHERE status = 'lobby' AND visibility = 'public' AND ($2::timestamptz IS NULL OR created_at < $2)
       ORDER BY created_at DESC LIMIT $1`,
      [limit + 1, before ?? null],
    );
    const items = rows.slice(0, limit).map((r) => this.summary(r));
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return { items, nextCursor: last ? last.created_at.toISOString() : null };
  }

  async joinByCode(player: Player, code: string): Promise<PlayerView> {
    const { rows } = await this.db.query<{ id: string }>('SELECT id FROM matches WHERE invite_code = $1', [
      code.toUpperCase(),
    ]);
    const id = rows[0]?.id;
    if (!id) throw new AppError(404, 'INVALID_INVITE_CODE', 'Código de invitación inválido');
    return this.join(player, id, true);
  }

  /** Unirse respeta la capacidad aunque varios lleguen a la vez: la fila de la partida se bloquea. */
  async join(player: Player, matchId: string, viaCode = false): Promise<PlayerView> {
    const { state } = await this.mutate(matchId, (s) => domainJoin(s, player, this.now()), {
      before: async (tx, row) => {
        if (row.visibility === 'private' && !viaCode) {
          throw new AppError(403, 'FORBIDDEN', 'La sala es privada: use el código de invitación');
        }
        if (row.state.players.some((p) => p.id === player.id)) return; // el dominio responderá ALREADY_JOINED
        await this.claimMembership(tx, player.id, matchId);
        await tx.query('INSERT INTO match_players (match_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
          matchId,
          player.id,
        ]);
      },
    });
    return playerView(state, player.id);
  }

  async leave(userId: string, matchId: string): Promise<void> {
    await this.mutate(matchId, (s) => domainLeave(s, userId, this.now()), {
      after: async (tx, t) => {
        await tx.query('DELETE FROM active_membership WHERE user_id = $1 AND match_id = $2', [userId, matchId]);
        if (t.state.status === 'lobby' || t.state.status === 'aborted') {
          await tx.query('DELETE FROM match_players WHERE user_id = $1 AND match_id = $2', [userId, matchId]);
        }
      },
    });
  }

  async setReady(userId: string, matchId: string, ready: boolean): Promise<void> {
    await this.mutate(matchId, (s) => domainSetReady(s, userId, ready, this.now(), this.rng));
  }

  // ───────────────────────────── partida ─────────────────────────────

  /**
   * Procesa una jugada. Orden: la fila se bloquea (FOR UPDATE), así que las jugadas de una partida
   * se procesan de a una aunque lleguen a réplicas distintas. Idempotencia: (partida, jugador, clientMoveId).
   */
  async submitAction(
    userId: string,
    matchId: string,
    clientMoveId: string,
    round: number,
    action: Action,
    receivedAt = this.now(),
  ): Promise<{ duplicate: boolean; seq: number }> {
    const result = await this.mutate(matchId, (s) => domainSubmit(s, userId, round, action, this.now()), {
      receivedAt,
      move: { userId, clientMoveId, round, action },
    });
    if (result.duplicateSeq !== null) {
      gameMetrics.actions.add(1, { result: 'duplicate' });
      return { duplicate: true, seq: result.duplicateSeq };
    }
    gameMetrics.actions.add(1, { result: 'accepted' });
    gameMetrics.actionLatency.record(this.now() - receivedAt);
    return { duplicate: false, seq: result.version };
  }

  async setPresence(userId: string, matchId: string, connected: boolean): Promise<void> {
    await this.mutate(matchId, (s) => {
      if (!s.players.some((p) => p.id === userId)) return null;
      if (s.status !== 'lobby' && s.status !== 'active') return null;
      return domainSetPresence(s, userId, connected, this.now());
    });
  }

  /** Avanza el reloj del servidor para una partida (temporizadores, gracia, expiración). */
  async tick(matchId: string): Promise<void> {
    await this.mutate(matchId, (s) => domainTick(s, this.now()), { skipLocked: true });
  }

  async terminate(matchId: string): Promise<void> {
    await this.mutate(matchId, (s) => domainTerminate(s, this.now()));
  }

  /** Crea y arranca una partida con jugadores emparejados. Devuelve null si alguno ya estaba en otra. */
  async createMatchmade(players: readonly Player[]): Promise<{ matchId: string; skipped: string[] }> {
    const [host] = players;
    if (!host) throw new Error('sin jugadores');
    const id = randomUUID();
    const now = this.now();
    let t = createMatch({ id, host, config: this.config, now });
    const events: DomainEvent[] = [...t.events];
    const skipped: string[] = [];
    await withTx(this.db, async (tx) => {
      await tx.query(
        `INSERT INTO matches (id, visibility, status, state, version, created_by) VALUES ($1, 'private', 'lobby', $2, 0, $3)`,
        [id, t.state, host.id],
      );
      const accepted: Player[] = [];
      for (const p of players) {
        const ok = await tx.query(
          'INSERT INTO active_membership (user_id, match_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [p.id, id],
        );
        if (ok.rowCount === 1) accepted.push(p);
        else skipped.push(p.id);
      }
      if (accepted.length < this.config.minPlayers) {
        throw new AppError(409, 'ALREADY_IN_MATCH', 'Emparejamiento cancelado: jugadores ya asignados');
      }
      if (!accepted.some((p) => p.id === host.id)) {
        t = createMatch({ id, host: accepted[0] ?? host, config: this.config, now });
        events.length = 0;
        events.push(...t.events);
      }
      for (const p of accepted) {
        if (p.id === t.state.hostId) continue;
        const j = domainJoin(t.state, p, now);
        t = j;
        events.push(...j.events);
      }
      const started = domainStart(t.state, now, this.rng);
      events.push(...started.events);
      for (const p of accepted) {
        await tx.query('INSERT INTO match_players (match_id, user_id) VALUES ($1, $2)', [id, p.id]);
      }
      await tx.query(
        `UPDATE matches SET state = $2, status = $3, version = $4, deadline = to_timestamp($5 / 1000.0) WHERE id = $1`,
        [id, started.state, started.state.status, events.length, nextDeadline(started.state)],
      );
      await this.insertEvents(tx, id, 1, events);
    });
    return { matchId: id, skipped };
  }

  // ───────────────────────────── lecturas ─────────────────────────────

  async getState(matchId: string): Promise<{ state: MatchState; version: number }> {
    const { rows } = await this.db.query<{ state: MatchState; version: number }>(
      'SELECT state, version FROM matches WHERE id = $1',
      [matchId],
    );
    const row = rows[0];
    if (!row) throw new AppError(404, 'NOT_FOUND', 'La partida no existe');
    return row;
  }

  /** Vista filtrada. Solo participantes (o administradores) pueden verla. */
  async getView(matchId: string, userId: string, isAdmin = false): Promise<{ view: PlayerView; seq: number }> {
    const { state, version } = await this.getState(matchId);
    const participant = state.players.some((p) => p.id === userId);
    if (!participant && !isAdmin) throw new AppError(403, 'NOT_A_PARTICIPANT', 'No participas en esta partida');
    return { view: playerView(state, participant ? userId : null), seq: version };
  }

  async replay(matchId: string, userId: string): Promise<{ matchId: string; events: StoredEvent[] }> {
    const { rows: member } = await this.db.query(
      'SELECT 1 FROM match_players WHERE match_id = $1 AND user_id = $2',
      [matchId, userId],
    );
    if (member.length === 0) throw new AppError(403, 'NOT_A_PARTICIPANT', 'Solo los participantes ven la repetición');
    const { rows } = await this.db.query<{ seq: number; payload: DomainEvent }>(
      `SELECT seq, payload FROM match_events WHERE match_id = $1 AND (recipient = 'all' OR recipient = $2) ORDER BY seq`,
      [matchId, userId],
    );
    return { matchId, events: rows.map((r) => ({ seq: r.seq, event: r.payload })) };
  }

  async history(
    userId: string,
    limit: number,
    before?: string,
  ): Promise<{ items: { matchId: string; status: string; finishedAt: string | null; result: unknown; won: boolean }[]; nextCursor: string | null }> {
    const { rows } = await this.db.query<{
      id: string;
      status: string;
      finished_at: Date | null;
      result: { winners: string[] } | null;
      joined_at: Date;
    }>(
      `SELECT m.id, m.status, m.finished_at, m.result, mp.joined_at
       FROM match_players mp JOIN matches m ON m.id = mp.match_id
       WHERE mp.user_id = $1 AND m.status IN ('finished', 'aborted') AND ($3::timestamptz IS NULL OR mp.joined_at < $3)
       ORDER BY mp.joined_at DESC LIMIT $2`,
      [userId, limit + 1, before ?? null],
    );
    const items = rows.slice(0, limit).map((r) => ({
      matchId: r.id,
      status: r.status,
      finishedAt: r.finished_at?.toISOString() ?? null,
      result: r.result,
      won: r.result?.winners.includes(userId) ?? false,
    }));
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return { items, nextCursor: last ? last.joined_at.toISOString() : null };
  }

  async listByStatus(status: string, limit: number): Promise<MatchSummary[]> {
    const { rows } = await this.db.query<{
      id: string;
      visibility: 'public' | 'private';
      status: string;
      state: MatchState;
      created_at: Date;
    }>('SELECT id, visibility, status, state, created_at FROM matches WHERE status = $1 ORDER BY created_at DESC LIMIT $2', [
      status,
      limit,
    ]);
    return rows.map((r) => this.summary(r));
  }

  async dueMatches(limit: number): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM matches WHERE status IN ('lobby', 'active') AND deadline <= now() ORDER BY deadline LIMIT $1`,
      [limit],
    );
    return rows.map((r) => r.id);
  }

  async activeMatchOf(userId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ match_id: string }>(
      'SELECT match_id FROM active_membership WHERE user_id = $1',
      [userId],
    );
    return rows[0]?.match_id ?? null;
  }

  async countActive(): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>("SELECT count(*) AS n FROM matches WHERE status = 'active'");
    return Number(rows[0]?.n ?? 0);
  }

  // ───────────────────────────── núcleo ─────────────────────────────

  /**
   * Única puerta de escritura: bloquea la fila, aplica la transición pura del dominio,
   * guarda estado + eventos en una transacción y, tras confirmar, difunde a todas las réplicas.
   */
  private async mutate(
    matchId: string,
    fn: (state: MatchState) => Transition | null,
    opts: MutateOptions = {},
  ): Promise<{ state: MatchState; version: number; duplicateSeq: number | null }> {
    const outcome = await withTx(this.db, async (tx) => {
      const params: unknown[] = [matchId];
      let dupSql = 'NULL::int';
      if (opts.move) {
        params.push(opts.move.userId, opts.move.clientMoveId);
        dupSql = '(SELECT a.seq FROM match_actions a WHERE a.match_id = m.id AND a.user_id = $2 AND a.client_move_id = $3)';
      }
      const { rows } = await tx.query<MatchRow & { dup_seq: number | null }>(
        `SELECT m.id, m.state, m.version, m.status, m.visibility, m.invite_code, ${dupSql} AS dup_seq
         FROM matches m WHERE m.id = $1 FOR UPDATE OF m${opts.skipLocked ? ' SKIP LOCKED' : ''}`,
        params,
      );
      const row = rows[0];
      if (!row) {
        if (opts.skipLocked) return null;
        throw new AppError(404, 'NOT_FOUND', 'La partida no existe');
      }
      if (row.dup_seq !== null) return { state: row.state, version: row.version, update: null, duplicateSeq: row.dup_seq };
      await opts.before?.(tx, row);
      let t: Transition | null;
      try {
        t = fn(row.state);
      } catch (err) {
        // Reenvíos simultáneos: el SELECT esperó el bloqueo con una foto anterior. Una consulta nueva
        // ve la jugada ya confirmada y responde como duplicada (idempotente) en vez de ALREADY_ACTED.
        if (opts.move && err instanceof DomainError && err.code === 'ALREADY_ACTED') {
          const dup = await tx.query<{ seq: number }>(
            'SELECT seq FROM match_actions WHERE match_id = $1 AND user_id = $2 AND client_move_id = $3',
            [matchId, opts.move.userId, opts.move.clientMoveId],
          );
          if (dup.rows[0]) return { state: row.state, version: row.version, update: null, duplicateSeq: dup.rows[0].seq };
        }
        throw err;
      }
      if (!t || (t.events.length === 0 && t.state === row.state)) {
        return { state: row.state, version: row.version, update: null, duplicateSeq: null };
      }
      const firstSeq = row.version + 1;
      const version = row.version + t.events.length;
      const ended = t.state.status === 'finished' || t.state.status === 'aborted';
      await this.writeTransition(tx, matchId, t, firstSeq, version, ended, opts.move);
      await opts.after?.(tx, t, firstSeq);
      const update: MatchUpdate = {
        matchId,
        fromSeq: firstSeq,
        toSeq: version,
        events: t.events.map((event, i) => ({ seq: firstSeq + i, event })),
        ...(this.broadcastMode === 'full' ? { state: t.state } : {}),
        ...(opts.receivedAt ? { receivedAt: opts.receivedAt } : {}),
      };
      return { state: t.state, version, update, duplicateSeq: null };
    });
    if (!outcome) return { ...(await this.getState(matchId)), duplicateSeq: null };
    if (outcome.update) {
      this.observe(outcome.update);
      // Si la difusión falla, los clientes se resincronizan por número de secuencia al reconectar.
      await this.bus.publishMatch(outcome.update).catch((err: unknown) => {
        this.log.error({ err, matchId }, 'no se pudo difundir la actualización');
      });
    }
    return { state: outcome.state, version: outcome.version, duplicateSeq: outcome.duplicateSeq };
  }

  /**
   * Una sola sentencia (CTE con escrituras) guarda eventos, la jugada, el nuevo estado y libera
   * las membresías si la partida terminó. Todo dentro de la transacción que tiene la fila bloqueada.
   */
  private async writeTransition(
    tx: Tx,
    matchId: string,
    t: Transition,
    firstSeq: number,
    version: number,
    ended: boolean,
    move?: MutateOptions['move'],
  ): Promise<void> {
    const values: unknown[] = [matchId, t.state, t.state.status, version, nextDeadline(t.state), t.state.result, ended];
    const p = (v: unknown): string => {
      values.push(v);
      return `$${values.length}`;
    };
    const ctes: string[] = [];
    if (t.events.length > 0) {
      const tuples = t.events.map((e, i) => `($1, ${p(firstSeq + i)}::int, ${p(e.type)}, ${p(e.to)}, ${p(e)}::jsonb)`);
      ctes.push(`ev AS (INSERT INTO match_events (match_id, seq, type, recipient, payload) VALUES ${tuples.join(', ')})`);
    }
    if (move) {
      ctes.push(
        `act AS (INSERT INTO match_actions (match_id, user_id, client_move_id, round, action, seq) VALUES ($1, ${p(move.userId)}::uuid, ${p(move.clientMoveId)}::uuid, ${p(move.round)}::int, ${p(move.action)}::jsonb, ${p(firstSeq)}::int))`,
      );
    }
    ctes.push('mem AS (DELETE FROM active_membership WHERE match_id = $1 AND $7::boolean)');
    await tx.query(
      `WITH ${ctes.join(', ')}
       UPDATE matches SET state = $2, status = $3, version = $4, deadline = to_timestamp($5 / 1000.0),
         result = $6, updated_at = now(), finished_at = CASE WHEN $7 THEN now() ELSE finished_at END
       WHERE id = $1`,
      values,
    );
  }

  private observe(update: MatchUpdate): void {
    for (const { event } of update.events) {
      if (event.type === 'round.resolved') gameMetrics.roundsResolved.add(1);
      if (event.type === 'match.ended') {
        gameMetrics.matchesFinished.add(1, { reason: event.result.reason });
        this.log.info({ matchId: update.matchId, result: event.result }, 'partida terminada');
      }
    }
  }

  private async insertEvents(tx: Tx, matchId: string, firstSeq: number, events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) return;
    const values: unknown[] = [];
    const tuples = events.map((e, i) => {
      values.push(matchId, firstSeq + i, e.type, e.to, e);
      const b = i * 5;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`;
    });
    await tx.query(`INSERT INTO match_events (match_id, seq, type, recipient, payload) VALUES ${tuples.join(', ')}`, values);
  }

  /** Inserta la membresía activa; la clave primaria impide estar en dos partidas a la vez. */
  private async claimMembership(tx: Tx, userId: string, matchId: string, beforeInsert?: () => Promise<void>): Promise<void> {
    await beforeInsert?.();
    try {
      await tx.query('SAVEPOINT claim');
      await tx.query('INSERT INTO active_membership (user_id, match_id) VALUES ($1, $2)', [userId, matchId]);
      await tx.query('RELEASE SAVEPOINT claim');
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(409, 'ALREADY_IN_MATCH', 'Ya estás en otra partida activa');
      }
      throw err;
    }
  }

  private newInviteCode(): string {
    let code = '';
    for (let i = 0; i < 6; i++) code += INVITE_ALPHABET.charAt(randomInt(INVITE_ALPHABET.length));
    return code;
  }

  private summary(r: { id: string; visibility: 'public' | 'private'; status: string; state: MatchState; created_at: Date }): MatchSummary {
    const host = r.state.players.find((p) => p.id === r.state.hostId);
    return {
      id: r.id,
      visibility: r.visibility,
      status: r.status,
      hostName: host?.name ?? '',
      players: r.state.players.length,
      maxPlayers: r.state.config.maxPlayers,
      createdAt: r.created_at.toISOString(),
    };
  }
}
