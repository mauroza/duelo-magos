import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  INSTANCE_ID: z.string().default(process.env.CONTAINER_APP_REPLICA_NAME ?? process.env.HOSTNAME ?? 'local'),

  /** Orígenes permitidos para CORS y para el handshake WebSocket. */
  ALLOWED_ORIGINS: z.string().default('http://localhost:8080'),

  /** local: cadena de conexión y secreto por variable (solo desarrollo). azure: identidad administrada. */
  AUTH_MODE: z.enum(['local', 'azure']).default('local'),
  AZURE_CLIENT_ID: z.string().optional(),
  KEY_VAULT_URI: z.url().optional(),

  DATABASE_URL: z.string().optional(),
  PGHOST: z.string().optional(),
  PGDATABASE: z.string().default('duelo'),
  PGUSER: z.string().optional(),
  PG_POOL_MAX: z.coerce.number().int().min(1).default(20),

  REDIS_URL: z.string().optional(),
  REDIS_HOST: z.string().optional(),
  REDIS_PORT: z.coerce.number().int().default(6380),
  /** Object ID de la identidad administrada (usuario de Redis con autenticación Entra). */
  REDIS_USERNAME: z.string().optional(),
  /**
   * entra: Azure Managed Redis con identidad administrada.
   * password: Redis en el entorno privado de Container Apps; la contraseña llega como secreto
   * de Container Apps referenciado a Key Vault (leído con identidad administrada).
   */
  REDIS_AUTH: z.enum(['entra', 'password']).default('entra'),
  REDIS_PASSWORD: z.string().min(16).optional(),
  REDIS_TLS: bool.default(true),

  /** Solo en desarrollo. En producción el secreto se lee de Key Vault. */
  JWT_SECRET: z.string().min(32).optional(),
  JWT_ISSUER: z.string().default('duelo-magos'),
  ACCESS_TOKEN_TTL_S: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_S: z.coerce.number().int().min(300).default(7 * 24 * 3600),
  WS_TICKET_TTL_S: z.coerce.number().int().min(5).max(120).default(30),

  ROUND_MS: z.coerce.number().int().min(1000).default(20_000),
  GRACE_MS: z.coerce.number().int().min(1000).default(30_000),
  MAX_ROUNDS: z.coerce.number().int().min(1).default(15),
  LOBBY_TTL_MS: z.coerce.number().int().min(10_000).default(10 * 60_000),
  MM_GROUP_SIZE: z.coerce.number().int().min(2).max(4).default(2),
  MM_MAX_WAIT_MS: z.coerce.number().int().min(5_000).default(60_000),

  RATE_LIMIT_HTTP_PER_MIN: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().min(1).default(10),
  WS_MSG_PER_SEC: z.coerce.number().min(1).default(10),
  WS_MSG_BURST: z.coerce.number().int().min(1).default(20),
  WS_MAX_PAYLOAD_BYTES: z.coerce.number().int().min(256).default(4096),
  WS_MAX_CONN_PER_USER: z.coerce.number().int().min(1).default(3),
  WS_HEARTBEAT_MS: z.coerce.number().int().min(1000).default(15_000),

  /** delta: solo eventos (optimizado). full: reenvía la vista completa en cada cambio (línea base). */
  BROADCAST_MODE: z.enum(['delta', 'full']).default('delta'),
  MIGRATE_ON_START: bool.default(true),
  SWEEP_INTERVAL_MS: z.coerce.number().int().min(50).default(500),
  SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).default(10_000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Configuración inválida: ${z.prettifyError(parsed.error)}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production') {
    if (cfg.AUTH_MODE !== 'azure') throw new Error('En producción AUTH_MODE debe ser "azure" (identidad administrada)');
    if (!cfg.KEY_VAULT_URI) throw new Error('En producción los secretos se leen de Key Vault: falta KEY_VAULT_URI');
    if (cfg.JWT_SECRET) throw new Error('JWT_SECRET no se permite en producción; use Key Vault');
  }
  return cfg;
}

export const allowedOrigins = (cfg: Config): string[] =>
  cfg.ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
