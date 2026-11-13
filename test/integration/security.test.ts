import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GameClient, HttpError } from '../../tools/game-client.js';
import { makeAdmin, newPlayer, resetInfra, startReplica, startedMatch, type Replica } from './harness.js';

let r: Replica;
let limited: Replica;

beforeAll(async () => {
  await resetInfra();
  r = await startReplica('sec-1');
  limited = await startReplica('sec-limited', { RATE_LIMIT_AUTH_PER_MIN: '3', WS_MSG_PER_SEC: '2', WS_MSG_BURST: '3', WS_MAX_CONN_PER_USER: '2' });
});
afterAll(async () => {
  await r.app.stop(100);
  await limited.app.stop(100);
});

/** Registra en la réplica normal y usa la réplica con límites estrictos solo para el WebSocket. */
const limitedClient = async (): Promise<GameClient> => {
  const base = await new GameClient(r.url).register();
  const c = new GameClient(limited.url, base.name);
  c.accessToken = base.accessToken;
  c.userId = base.userId;
  return c;
};

const code = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as HttpError).body.code;
  }
};

describe('autenticación', () => {
  it('rechaza HTTP sin token y con token falso', async () => {
    const c = new GameClient(r.url);
    await expect(c.http('GET', '/v1/users/me')).rejects.toMatchObject({ status: 401 });
    c.accessToken = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.firma-falsa';
    await expect(c.http('GET', '/v1/users/me')).rejects.toMatchObject({ status: 401 });
  });

  it('los errores siguen RFC 9457 Problem Details', async () => {
    const res = await fetch(`${r.url}/v1/users/me`);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(body.type).toBeTypeOf('string');
    expect(body.title).toBeTypeOf('string');
  });

  it('el refresh token rota y reutilizarlo revoca toda la familia', async () => {
    const c = await new GameClient(r.url).register();
    const first = c.refreshToken;
    const rotated = await c.http<{ refreshToken: string }>('POST', '/v1/auth/refresh', { refreshToken: first }, false);
    expect(rotated.refreshToken).not.toBe(first);
    expect(await code(c.http('POST', '/v1/auth/refresh', { refreshToken: first }, false))).toBe('TOKEN_REUSED');
    // El token legítimo también quedó revocado (posible robo).
    expect(await code(c.http('POST', '/v1/auth/refresh', { refreshToken: rotated.refreshToken }, false))).toBe('TOKEN_REUSED');
  });

  it('WebSocket sin ticket, con ticket inválido o reutilizado se cierra con 4001', async () => {
    const c = await new GameClient(r.url).register();
    await expect(c.connect('ticket-inventado-que-no-existe-123')).rejects.toThrow('4001');
    const { ticket } = await c.http<{ ticket: string }>('POST', '/v1/realtime/ticket');
    await c.connect(ticket);
    await c.close();
    const again = new GameClient(r.url, c.name);
    again.accessToken = c.accessToken;
    await expect(again.connect(ticket)).rejects.toThrow('4001');
  });

  it('origen de WebSocket no permitido se cierra con 4003', async () => {
    const c = await new GameClient(r.url, undefined, { origin: 'https://sitio-malicioso.example' }).register();
    await expect(c.connect()).rejects.toThrow('4003');
  });

  it('contraseñas cortas y campos extra se rechazan (validación de esquema)', async () => {
    const c = new GameClient(r.url);
    expect(await code(c.http('POST', '/v1/auth/register', { username: 'corto', password: '123' }, false))).toBe('VALIDATION_FAILED');
    expect(
      await code(c.http('POST', '/v1/auth/register', { username: 'valido1', password: 'una-clave-larga', role: 'admin' }, false)),
    ).toBe('VALIDATION_FAILED');
  });
});

describe('autorización por partida', () => {
  it('quien no participa no ve la partida, no se suscribe ni juega', async () => {
    const { matchId, players } = await startedMatch([r.url], 2);
    const intruder = await newPlayer(r.url);
    await expect(intruder.http('GET', `/v1/matches/${matchId}`)).rejects.toMatchObject({ status: 403 });
    await expect(intruder.http('GET', `/v1/matches/${matchId}/replay`)).rejects.toMatchObject({ status: 403 });
    const sub = await intruder.request('match.subscribe', { matchId });
    expect(sub.type).toBe('error');
    expect((sub.payload as { code: string }).code).toBe('NOT_A_PARTICIPANT');
    const act = await intruder.act(matchId, 1, { kind: 'channel' });
    expect((act.payload as { code: string }).code).toBe('NOT_A_PARTICIPANT');
    // Tampoco puede jugar en nombre de otro: el jugador sale del ticket, no del mensaje.
    await Promise.all([...players, intruder].map((p) => p.close()));
  });

  it('solo el administrador usa la administración y cada acción queda auditada', async () => {
    const player = await newPlayer(r.url);
    await expect(player.http('GET', '/v1/admin/matches')).rejects.toMatchObject({ status: 403 });
    const admin = await newPlayer(r.url, 'admin');
    await makeAdmin(admin.userId);
    await admin.login();
    const { matchId, players } = await startedMatch([r.url], 2);
    await admin.http('POST', `/v1/admin/matches/${matchId}/terminate`);
    const ended = await players[0]!.http<{ view: { status: string } }>('GET', `/v1/matches/${matchId}`);
    expect(ended.view.status).toBe('aborted');
    await admin.http('POST', `/v1/admin/users/${player.userId}/suspend`);
    await expect(player.login()).rejects.toMatchObject({ status: 403 });
    await expect(player.http('GET', '/v1/users/me')).rejects.toMatchObject({ status: 403 });
    const audit = await admin.http<{ items: { action: string; target: string }[] }>('GET', '/v1/admin/audit?limit=10');
    expect(audit.items.map((i) => i.action)).toEqual(expect.arrayContaining(['match.terminate', 'user.suspend']));
    await Promise.all([admin, ...players].map((p) => p.close()));
  });
});

describe('información oculta', () => {
  it('ningún mensaje revela la afinidad ni la jugada pendiente de otro jugador', async () => {
    const { matchId, players } = await startedMatch([r.url], 2);
    const [a, b] = players;
    const affA = a!.views.get(matchId)!.you!.affinity!;
    // A juega; B no debe saber qué jugó hasta que se resuelva la ronda.
    await a!.act(matchId, 1, { kind: 'attack', element: affA, target: b!.userId });
    await new Promise((res) => setTimeout(res, 200));
    const beforeResolve = JSON.stringify(b!.received);
    expect(beforeResolve).not.toContain('"attack"');
    // B recibió exactamente una afinidad: la suya.
    const affinities = b!.received.flatMap((m) =>
      m.type === 'match.update' ? (m.payload.events as { type: string; affinity?: string }[]).filter((e) => e.type === 'affinity.assigned') : [],
    );
    expect(affinities).toHaveLength(1);
    expect(affinities[0]!.affinity).toBe(b!.views.get(matchId)!.you!.affinity);
    const { view } = await b!.http<{ view: { you: { affinity: string }; players: { id: string }[]; affinities: unknown } }>('GET', `/v1/matches/${matchId}`);
    expect(view.affinities).toBeNull();
    expect(JSON.stringify(view)).not.toContain('"attack"');
    await Promise.all(players.map((p) => p.close()));
  });
});

describe('límites', () => {
  it('HTTP: 429 con Retry-After al exceder la tasa de autenticación', async () => {
    const c = new GameClient(limited.url);
    let last: HttpError | undefined;
    for (let i = 0; i < 6; i++) {
      try {
        await c.http('POST', '/v1/auth/login', { username: 'nadie', password: 'x' }, false);
      } catch (e) {
        last = e as HttpError;
      }
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get('retry-after')).toBeTruthy();
    expect(last?.body.code).toBe('RATE_LIMITED');
  });

  it('WebSocket: mensajes en exceso, JSON inválido y esquema inválido se rechazan sin cerrar la conexión', async () => {
    const c = await limitedClient();
    await c.connect();
    c.sendRaw('{esto no es json');
    c.sendRaw(JSON.stringify({ v: 1, type: 'action.submit', payload: { matchId: 'x', round: -1 } }));
    for (let i = 0; i < 10; i++) c.send('ping', {});
    await new Promise((res) => setTimeout(res, 300));
    const errors = c.received.filter((m) => m.type === 'error').map((m) => (m.payload as { code: string }).code);
    expect(errors).toContain('VALIDATION_FAILED');
    expect(errors).toContain('RATE_LIMITED');
    expect(c.closeCode).toBeNull();
    await c.close();
  });

  it('WebSocket: mensaje más grande que el máximo cierra con 1009', async () => {
    const c = await new GameClient(r.url).register();
    await c.connect();
    const closed = new Promise<number>((res) => c.ws!.once('close', (code) => res(code)));
    c.sendRaw(JSON.stringify({ v: 1, type: 'ping', payload: { relleno: 'x'.repeat(10_000) } }));
    expect(await closed).toBe(1009);
  });

  it('máximo de conexiones simultáneas por usuario (4009)', async () => {
    const c = await limitedClient();
    await c.connect();
    const c2 = new GameClient(limited.url, c.name);
    c2.accessToken = c.accessToken;
    await c2.connect();
    const c3 = new GameClient(limited.url, c.name);
    c3.accessToken = c.accessToken;
    await expect(c3.connect()).rejects.toThrow('4009');
    await c.close();
    await c2.close();
  });

  it('encabezados de seguridad HTTP presentes', async () => {
    const res = await fetch(`${r.url}/health/live`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('strict-transport-security')).toContain('max-age');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });
});
