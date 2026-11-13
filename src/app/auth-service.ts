import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { Redis } from 'ioredis';
import { SignJWT, jwtVerify } from 'jose';
import type { Db } from '../infra/db.js';
import { AppError } from './errors.js';

export type Role = 'player' | 'admin';

export interface AuthUser {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
}

export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: number;
}

export interface AuthOptions {
  readonly signingKey: Uint8Array;
  readonly issuer: string;
  readonly accessTtlS: number;
  readonly refreshTtlS: number;
}

const AUDIENCE = 'duelo-magos-api';
// Parámetros Argon2id recomendados por OWASP (19 MiB, 2 iteraciones).
const ARGON = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');
// Hash ficticio para igualar el tiempo de respuesta cuando el usuario no existe.
let dummyHash: Promise<string> | undefined;

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
  suspended_at: Date | null;
  created_at: Date;
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly redis: Redis,
    private readonly opts: AuthOptions,
  ) {}

  async register(username: string, password: string, displayName: string): Promise<{ user: AuthUser; tokens: TokenPair }> {
    const id = randomUUID();
    const passwordHash = await hash(password, ARGON);
    try {
      await this.db.query(
        'INSERT INTO users (id, username, display_name, password_hash) VALUES ($1, $2, $3, $4)',
        [id, username, displayName, passwordHash],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(409, 'USERNAME_TAKEN', 'El nombre de usuario ya existe');
      }
      throw err;
    }
    const user: AuthUser = { id, name: displayName, role: 'player' };
    return { user, tokens: await this.issueTokens(user, randomUUID()) };
  }

  async login(username: string, password: string): Promise<{ user: AuthUser; tokens: TokenPair }> {
    const { rows } = await this.db.query<UserRow>('SELECT * FROM users WHERE username = $1', [username]);
    const row = rows[0];
    if (!row) {
      dummyHash ??= hash('contraseña-ficticia', ARGON);
      await verify(await dummyHash, password).catch(() => false);
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Usuario o contraseña incorrectos');
    }
    if (!(await verify(row.password_hash, password))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Usuario o contraseña incorrectos');
    }
    if (row.suspended_at) throw new AppError(403, 'ACCOUNT_SUSPENDED', 'La cuenta está suspendida');
    const user: AuthUser = { id: row.id, name: row.display_name, role: row.role };
    return { user, tokens: await this.issueTokens(user, randomUUID()) };
  }

  /** Rota el refresh token. Si se presenta uno ya usado, se revoca toda la familia (posible robo). */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const { rows } = await this.db.query<{
      id: string;
      user_id: string;
      family_id: string;
      expires_at: Date;
      revoked_at: Date | null;
    }>('SELECT id, user_id, family_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1', [
      sha256(refreshToken),
    ]);
    const row = rows[0];
    if (!row) throw new AppError(401, 'UNAUTHENTICATED', 'Refresh token inválido');
    if (row.revoked_at) {
      await this.revokeFamily(row.family_id);
      throw new AppError(401, 'TOKEN_REUSED', 'Refresh token reutilizado: se cerraron todas las sesiones de esa familia');
    }
    if (row.expires_at.getTime() < Date.now()) throw new AppError(401, 'UNAUTHENTICATED', 'Refresh token expirado');
    const revoked = await this.db.query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
      [row.id],
    );
    if (revoked.rowCount !== 1) {
      // Dos solicitudes simultáneas con el mismo token: solo una puede ganar.
      await this.revokeFamily(row.family_id);
      throw new AppError(401, 'TOKEN_REUSED', 'Refresh token reutilizado');
    }
    const user = await this.getUser(row.user_id);
    if (user.suspended) throw new AppError(403, 'ACCOUNT_SUSPENDED', 'La cuenta está suspendida');
    return this.issueTokens({ id: user.id, name: user.displayName, role: user.role }, row.family_id);
  }

  async logout(refreshToken: string): Promise<void> {
    const { rows } = await this.db.query<{ family_id: string }>(
      'SELECT family_id FROM refresh_tokens WHERE token_hash = $1',
      [sha256(refreshToken)],
    );
    if (rows[0]) await this.revokeFamily(rows[0].family_id);
  }

  async verifyAccess(token: string): Promise<AuthUser> {
    try {
      const { payload } = await jwtVerify(token, this.opts.signingKey, {
        issuer: this.opts.issuer,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      const role = payload.role === 'admin' ? 'admin' : 'player';
      if (typeof payload.sub !== 'string' || typeof payload.name !== 'string') throw new Error('claims');
      if (await this.isSuspended(payload.sub)) throw new AppError(403, 'ACCOUNT_SUSPENDED', 'La cuenta está suspendida');
      return { id: payload.sub, name: payload.name, role };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(401, 'UNAUTHENTICATED', 'Token de acceso inválido o expirado');
    }
  }

  async getUser(id: string): Promise<{
    id: string;
    username: string;
    displayName: string;
    role: Role;
    suspended: boolean;
    createdAt: string;
  }> {
    const { rows } = await this.db.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    const row = rows[0];
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Usuario no encontrado');
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      suspended: row.suspended_at !== null,
      createdAt: row.created_at.toISOString(),
    };
  }

  async updateDisplayName(id: string, displayName: string): Promise<void> {
    await this.db.query('UPDATE users SET display_name = $2 WHERE id = $1', [id, displayName]);
  }

  async setSuspended(userId: string, suspended: boolean): Promise<void> {
    const res = await this.db.query(
      `UPDATE users SET suspended_at = ${suspended ? 'now()' : 'NULL'} WHERE id = $1`,
      [userId],
    );
    if (res.rowCount !== 1) throw new AppError(404, 'NOT_FOUND', 'Usuario no encontrado');
    if (suspended) {
      await this.redis.sadd('suspended', userId);
      await this.db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [
        userId,
      ]);
    } else {
      await this.redis.srem('suspended', userId);
    }
  }

  async isSuspended(userId: string): Promise<boolean> {
    return (await this.redis.sismember('suspended', userId)) === 1;
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [
      familyId,
    ]);
  }

  private async issueTokens(user: AuthUser, familyId: string): Promise<TokenPair> {
    const accessToken = await new SignJWT({ name: user.name, role: user.role })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(user.id)
      .setIssuer(this.opts.issuer)
      .setAudience(AUDIENCE)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${this.opts.accessTtlS}s`)
      .sign(this.opts.signingKey);
    const refreshToken = randomBytes(32).toString('base64url');
    await this.db.query(
      `INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
      [randomUUID(), user.id, familyId, sha256(refreshToken), this.opts.refreshTtlS],
    );
    return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: this.opts.accessTtlS };
  }
}
