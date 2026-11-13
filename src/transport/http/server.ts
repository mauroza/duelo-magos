import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { AuthService, AuthUser } from '../../app/auth-service.js';
import { AppError } from '../../app/errors.js';
import type { MatchService } from '../../app/match-service.js';
import type { Matchmaker } from '../../app/matchmaking.js';
import type { Db } from '../../infra/db.js';
import type { EventBus } from '../../infra/bus.js';
import type { ConnectionRegistry, TicketStore } from '../../infra/redis.js';
import { gameMetrics } from '../../observability/metrics.js';
import { problemHandler } from './problem.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface HttpDeps {
  readonly log: Logger;
  readonly db: Db;
  readonly redis: Redis;
  readonly auth: AuthService;
  readonly matches: MatchService;
  readonly matchmaker: Matchmaker;
  readonly tickets: TicketStore;
  readonly connections: ConnectionRegistry;
  readonly bus: EventBus;
  readonly allowedOrigins: string[];
  readonly rateLimitPerMin: number;
  readonly authRateLimitPerMin: number;
  readonly isReady: () => boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

// ───────────── esquemas de entrada (la fuente de verdad es contracts/openapi.yaml) ─────────────
const Username = z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_.-]+$/);
const Password = z.string().min(10).max(128);
const DisplayName = z.string().trim().min(1).max(32);
const Uuid = z.uuid();
const RegisterBody = z.object({ username: Username, password: Password, displayName: DisplayName.optional() }).strict();
const LoginBody = z.object({ username: Username, password: z.string().min(1).max(128) }).strict();
const RefreshBody = z.object({ refreshToken: z.string().min(20).max(200) }).strict();
const PatchMeBody = z.object({ displayName: DisplayName }).strict();
const CreateMatchBody = z
  .object({ visibility: z.enum(['public', 'private']).default('public'), maxPlayers: z.number().int().min(2).max(4).optional() })
  .strict();
const JoinCodeBody = z.object({ code: z.string().trim().regex(/^[A-Za-z0-9]{6}$/) }).strict();
const ReadyBody = z.object({ ready: z.boolean() }).strict();
const IdParams = z.object({ id: Uuid });
const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.iso.datetime().optional(),
});
const AdminMatchesQuery = z.object({
  status: z.enum(['lobby', 'active', 'finished', 'aborted']).default('active'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function buildHttpServer(deps: HttpDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.log as unknown as FastifyBaseLogger,
    bodyLimit: 16 * 1024,
    trustProxy: true,
    genReqId: () => crypto.randomUUID(),
  });
  app.setErrorHandler(problemHandler);
  app.setNotFoundHandler((req, reply) => problemHandler(new AppError(404, 'NOT_FOUND', 'Ruta no encontrada'), req, reply));

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", 'wss:', 'ws:'],
        imgSrc: ["'self'", 'data:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
      },
    },
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
  });
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || deps.allowedOrigins.includes(origin)),
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });
  await app.register(rateLimit, {
    global: true,
    max: deps.rateLimitPerMin,
    timeWindow: '1 minute',
    redis: deps.redis,
    nameSpace: 'rl:http:',
    // Por usuario (firma del token, imposible de falsificar) o, sin token, por IP.
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      const sig = auth?.startsWith('Bearer ') ? auth.split('.')[2] : undefined;
      return sig ? `tok:${sig.slice(0, 32)}` : `ip:${req.ip}`;
    },
    allowList: (req) => req.url.startsWith('/health'),
    onExceeded: () => gameMetrics.rateLimited.add(1, { transport: 'http' }),
    errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, message: `Reintente en ${ctx.after}` }),
  });

  // ───────────── contratos y documentación ─────────────
  await app.register(swagger, {
    mode: 'static',
    specification: { path: join(ROOT, 'contracts', 'openapi.yaml'), baseDir: join(ROOT, 'contracts') },
  });
  await app.register(swaggerUi, { routePrefix: '/docs', staticCSP: true });
  app.get('/contracts/asyncapi.yaml', { config: { rateLimit: false } }, async (_req, reply) =>
    reply.type('application/yaml').send(await readFile(join(ROOT, 'contracts', 'asyncapi.yaml'), 'utf8')),
  );
  await app.register(fastifyStatic, { root: join(ROOT, 'client'), prefix: '/play/' });
  app.get('/', async (_req, reply) => reply.redirect('/play/'));

  // ───────────── salud ─────────────
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_req, reply) => {
    const checks = { db: false, redis: false, accepting: deps.isReady() };
    await Promise.all([
      deps.db.query('SELECT 1').then(() => (checks.db = true)).catch(() => undefined),
      deps.redis.ping().then(() => (checks.redis = true)).catch(() => undefined),
    ]);
    const ok = checks.db && checks.redis && checks.accepting;
    return reply.status(ok ? 200 : 503).send({ status: ok ? 'ready' : 'not_ready', checks });
  });

  // ───────────── autenticación ─────────────
  const authenticate = async (req: FastifyRequest): Promise<AuthUser> => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new AppError(401, 'UNAUTHENTICATED', 'Falta el token de acceso');
    const user = await deps.auth.verifyAccess(header.slice(7));
    req.user = user;
    return user;
  };
  const requireAdmin = async (req: FastifyRequest): Promise<AuthUser> => {
    const user = await authenticate(req);
    if (user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Solo administradores');
    return user;
  };
  const authLimit = { config: { rateLimit: { max: deps.authRateLimitPerMin, timeWindow: '1 minute' } } };

  app.post('/v1/auth/register', authLimit, async (req, reply) => {
    const body = RegisterBody.parse(req.body);
    const { user, tokens } = await deps.auth.register(body.username, body.password, body.displayName ?? body.username);
    return reply.status(201).send({ user, ...tokens });
  });
  app.post('/v1/auth/login', authLimit, async (req) => {
    const body = LoginBody.parse(req.body);
    const { user, tokens } = await deps.auth.login(body.username, body.password);
    return { user, ...tokens };
  });
  app.post('/v1/auth/refresh', authLimit, async (req) => deps.auth.refresh(RefreshBody.parse(req.body).refreshToken));
  app.post('/v1/auth/logout', async (req, reply) => {
    await deps.auth.logout(RefreshBody.parse(req.body).refreshToken);
    return reply.status(204).send();
  });

  app.get('/v1/users/me', async (req) => {
    const user = await authenticate(req);
    return deps.auth.getUser(user.id);
  });
  app.patch('/v1/users/me', async (req) => {
    const user = await authenticate(req);
    await deps.auth.updateDisplayName(user.id, PatchMeBody.parse(req.body).displayName);
    return deps.auth.getUser(user.id);
  });

  /** Ticket de un solo uso (30 s) para autenticar el handshake WebSocket sin poner el JWT en la URL. */
  app.post('/v1/realtime/ticket', async (req, reply) => {
    const user = await authenticate(req);
    return reply.status(201).send(await deps.tickets.issue(user.id));
  });

  // ───────────── salas y partidas ─────────────
  app.post('/v1/matches', async (req, reply) => {
    const user = await authenticate(req);
    const body = CreateMatchBody.parse(req.body ?? {});
    const created = await deps.matches.createRoom(user, body.visibility, body.maxPlayers);
    return reply.status(201).send(created);
  });
  app.get('/v1/matches', async (req) => {
    await authenticate(req);
    const q = PageQuery.parse(req.query);
    return deps.matches.listOpen(q.limit, q.cursor);
  });
  app.post('/v1/matches/join-by-code', async (req) => {
    const user = await authenticate(req);
    return deps.matches.joinByCode(user, JoinCodeBody.parse(req.body).code);
  });
  app.get('/v1/matches/:id', async (req) => {
    const user = await authenticate(req);
    const { id } = IdParams.parse(req.params);
    return deps.matches.getView(id, user.id, user.role === 'admin');
  });
  app.post('/v1/matches/:id/join', async (req) => {
    const user = await authenticate(req);
    return deps.matches.join(user, IdParams.parse(req.params).id);
  });
  app.post('/v1/matches/:id/leave', async (req, reply) => {
    const user = await authenticate(req);
    await deps.matches.leave(user.id, IdParams.parse(req.params).id);
    return reply.status(204).send();
  });
  app.post('/v1/matches/:id/ready', async (req, reply) => {
    const user = await authenticate(req);
    await deps.matches.setReady(user.id, IdParams.parse(req.params).id, ReadyBody.parse(req.body).ready);
    return reply.status(204).send();
  });
  app.get('/v1/matches/:id/replay', async (req) => {
    const user = await authenticate(req);
    return deps.matches.replay(IdParams.parse(req.params).id, user.id);
  });

  app.post('/v1/matchmaking/queue', async (req, reply) => {
    const user = await authenticate(req);
    return reply.status(202).send(await deps.matchmaker.enqueue(user));
  });
  app.delete('/v1/matchmaking/queue', async (req, reply) => {
    const user = await authenticate(req);
    await deps.matchmaker.dequeue(user.id);
    return reply.status(204).send();
  });

  app.get('/v1/history', async (req) => {
    const user = await authenticate(req);
    const q = PageQuery.parse(req.query);
    return deps.matches.history(user.id, q.limit, q.cursor);
  });

  // ───────────── administración (cada acción queda auditada) ─────────────
  const audit = async (actorId: string, action: string, target: string, details: object = {}): Promise<void> => {
    await deps.db.query('INSERT INTO audit_log (actor_id, action, target, details) VALUES ($1, $2, $3, $4)', [
      actorId,
      action,
      target,
      details,
    ]);
  };
  app.get('/v1/admin/matches', async (req) => {
    const admin = await requireAdmin(req);
    const q = AdminMatchesQuery.parse(req.query);
    await audit(admin.id, 'matches.list', q.status);
    return { items: await deps.matches.listByStatus(q.status, q.limit) };
  });
  app.get('/v1/admin/connections', async (req) => {
    const admin = await requireAdmin(req);
    await audit(admin.id, 'connections.list', '*');
    const items = await deps.connections.snapshot();
    return { total: items.reduce((a, b) => a + b.connections, 0), items };
  });
  app.post('/v1/admin/matches/:id/terminate', async (req, reply) => {
    const admin = await requireAdmin(req);
    const { id } = IdParams.parse(req.params);
    await deps.matches.terminate(id);
    await audit(admin.id, 'match.terminate', id);
    return reply.status(204).send();
  });
  app.post('/v1/admin/users/:id/suspend', async (req, reply) => {
    const admin = await requireAdmin(req);
    const { id } = IdParams.parse(req.params);
    if (id === admin.id) throw new AppError(409, 'FORBIDDEN', 'Un administrador no puede suspenderse a sí mismo');
    await deps.auth.setSuspended(id, true);
    await deps.bus.publishUser(id, { type: 'kick', reason: 'suspended' });
    await audit(admin.id, 'user.suspend', id);
    return reply.status(204).send();
  });
  app.post('/v1/admin/users/:id/reinstate', async (req, reply) => {
    const admin = await requireAdmin(req);
    const { id } = IdParams.parse(req.params);
    await deps.auth.setSuspended(id, false);
    await audit(admin.id, 'user.reinstate', id);
    return reply.status(204).send();
  });
  app.get('/v1/admin/audit', async (req) => {
    await requireAdmin(req);
    const q = PageQuery.parse(req.query);
    const { rows } = await deps.db.query(
      'SELECT id, actor_id AS "actorId", action, target, details, created_at AS "createdAt" FROM audit_log ORDER BY id DESC LIMIT $1',
      [q.limit],
    );
    return { items: rows };
  });

  return app;
}
