import { z } from 'zod';
import { ELEMENTS } from '../../domain/index.js';

/**
 * Protocolo de tiempo real v1. Documentado en contracts/asyncapi.yaml; una prueba verifica
 * que los ejemplos del contrato pasan estos esquemas y que no falta ni sobra ningún mensaje.
 */
export const PROTOCOL_VERSION = 1;

const MsgId = z.string().min(1).max(64);
const Uuid = z.uuid();

export const ActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('attack'), element: z.enum(ELEMENTS), target: Uuid }).strict(),
  z.object({ kind: z.literal('shield') }).strict(),
  z.object({ kind: z.literal('channel') }).strict(),
]);

const envelope = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.object({ v: z.literal(PROTOCOL_VERSION), type: z.literal(type), id: MsgId.optional(), payload }).strict();

export const ClientMessage = z.discriminatedUnion('type', [
  envelope('match.subscribe', z.object({ matchId: Uuid }).strict()),
  envelope('match.unsubscribe', z.object({ matchId: Uuid }).strict()),
  envelope('match.ready', z.object({ matchId: Uuid, ready: z.boolean() }).strict()),
  envelope(
    'action.submit',
    z
      .object({
        matchId: Uuid,
        /** Generado por el cliente; si reenvía la jugada tras perder la señal no se aplica dos veces. */
        clientMoveId: Uuid,
        /** Ronda sobre la que se decidió la jugada: si el estado avanzó, se rechaza (STALE_ROUND). */
        round: z.number().int().min(1).max(1000),
        action: ActionSchema,
      })
      .strict(),
  ),
  envelope('ping', z.object({}).strict()),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const CLIENT_MESSAGE_TYPES = ClientMessage.options.map((o) => o.shape.type.value);

/** Mensajes que envía el servidor (también tipados para generar ejemplos y probar el contrato). */
export const SERVER_MESSAGE_TYPES = [
  'welcome',
  'ack',
  'error',
  'match.sync',
  'match.update',
  'matchmaking.matched',
  'matchmaking.timeout',
  'pong',
] as const;
export type ServerMessageType = (typeof SERVER_MESSAGE_TYPES)[number];

/** Códigos de cierre documentados en AsyncAPI. */
export const CloseCodes = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  UNAUTHORIZED: 4001,
  FORBIDDEN_ORIGIN: 4003,
  POLICY_VIOLATION: 4008,
  TOO_MANY_CONNECTIONS: 4009,
  SUSPENDED: 4010,
  HEARTBEAT_TIMEOUT: 4011,
  SERVER_RESTART: 4012,
} as const;
