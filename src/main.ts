import { allowedOrigins, loadConfig, type Config } from './config.js';
import { AuthService } from './app/auth-service.js';
import { MatchService } from './app/match-service.js';
import { Matchmaker } from './app/matchmaking.js';
import { Scheduler } from './app/scheduler.js';
import { DEFAULT_CONFIG, type MatchConfig } from './domain/index.js';
import { loadSecrets } from './infra/azure.js';
import { EventBus } from './infra/bus.js';
import { createPool, migrate } from './infra/db.js';
import { ConnectionRegistry, PresenceStore, TicketStore, createRedis } from './infra/redis.js';
import { createLogger } from './observability/logger.js';
import { buildHttpServer } from './transport/http/server.js';
import { Gateway } from './transport/ws/gateway.js';

export function matchConfigFrom(cfg: Config): MatchConfig {
  return {
    ...DEFAULT_CONFIG,
    roundMs: cfg.ROUND_MS,
    graceMs: cfg.GRACE_MS,
    maxRounds: cfg.MAX_ROUNDS,
    lobbyTtlMs: cfg.LOBBY_TTL_MS,
  };
}

/** Arma la aplicación completa. Lo usan main y las pruebas de integración (varias "réplicas" en un proceso). */
export async function createApp(cfg: Config) {
  const log = createLogger(cfg.LOG_LEVEL, cfg.INSTANCE_ID);
  const secrets = await loadSecrets(cfg);
  const db = createPool(cfg);
  if (cfg.MIGRATE_ON_START) {
    const applied = await migrate(db);
    if (applied.length) log.info({ applied }, 'migraciones aplicadas');
  }
  const redis = await createRedis(cfg);
  const bus = new EventBus(redis.cmd, redis.sub);
  const auth = new AuthService(db, redis.cmd, {
    signingKey: secrets.jwtSigningKey,
    issuer: cfg.JWT_ISSUER,
    accessTtlS: cfg.ACCESS_TOKEN_TTL_S,
    refreshTtlS: cfg.REFRESH_TOKEN_TTL_S,
  });
  const matches = new MatchService(db, bus, matchConfigFrom(cfg), log, cfg.BROADCAST_MODE);
  const matchmaker = new Matchmaker(redis.cmd, matches, bus, log, {
    groupSize: cfg.MM_GROUP_SIZE,
    maxWaitMs: cfg.MM_MAX_WAIT_MS,
    instanceId: cfg.INSTANCE_ID,
  });
  const scheduler = new Scheduler(db, redis.cmd, matches, log, { sweepMs: cfg.SWEEP_INTERVAL_MS, instanceId: cfg.INSTANCE_ID });
  const tickets = new TicketStore(redis.cmd, cfg.WS_TICKET_TTL_S);
  const connections = new ConnectionRegistry(redis.cmd, cfg.WS_MAX_CONN_PER_USER);
  const presence = new PresenceStore(redis.cmd);
  const origins = allowedOrigins(cfg);

  let ready = true;
  const http = await buildHttpServer({
    log,
    db,
    redis: redis.cmd,
    auth,
    matches,
    matchmaker,
    tickets,
    connections,
    bus,
    allowedOrigins: origins,
    rateLimitPerMin: cfg.RATE_LIMIT_HTTP_PER_MIN,
    authRateLimitPerMin: cfg.RATE_LIMIT_AUTH_PER_MIN,
    isReady: () => ready,
  });
  const gateway = new Gateway({
    log,
    auth,
    matches,
    bus,
    tickets,
    connections,
    presence,
    allowedOrigins: origins,
    maxPayloadBytes: cfg.WS_MAX_PAYLOAD_BYTES,
    heartbeatMs: cfg.WS_HEARTBEAT_MS,
    msgPerSec: cfg.WS_MSG_PER_SEC,
    msgBurst: cfg.WS_MSG_BURST,
    broadcastMode: cfg.BROADCAST_MODE,
  });
  gateway.attach(http.server);

  return {
    log,
    db,
    redis,
    http,
    gateway,
    auth,
    matches,
    matchmaker,
    scheduler,
    async start(port: number, host = '0.0.0.0'): Promise<string> {
      const address = await http.listen({ port, host });
      scheduler.start();
      matchmaker.start();
      return address;
    },
    /** Cierre ordenado: deja de recibir, pide a los clientes reconectar y libera recursos. */
    async stop(drainMs = cfg.SHUTDOWN_DRAIN_MS): Promise<void> {
      ready = false;
      scheduler.stop();
      matchmaker.stop();
      await gateway.shutdown(drainMs);
      await http.close();
      await redis.close();
      await db.end();
    },
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = await createApp(cfg);
  const address = await app.start(cfg.PORT);
  app.log.info({ address, instance: cfg.INSTANCE_ID, mode: cfg.BROADCAST_MODE }, 'servidor iniciado');

  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      app.log.info({ signal }, 'apagado ordenado');
      void app.stop().then(
        () => process.exit(0),
        (err: unknown) => {
          app.log.error({ err }, 'error al apagar');
          process.exit(1);
        },
      );
    });
  }
  process.on('unhandledRejection', (err) => app.log.error({ err }, 'promesa rechazada sin manejar'));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err: unknown) => {
    console.error('No se pudo iniciar el servidor', err);
    process.exit(1);
  });
}
