import { DefaultAzureCredential, ManagedIdentityCredential, type TokenCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import type { Config } from '../config.js';

let credential: TokenCredential | undefined;

/** Identidad administrada asignada por el usuario (sin claves ni cadenas de conexión). */
export function azureCredential(cfg: Config): TokenCredential {
  credential ??= cfg.AZURE_CLIENT_ID
    ? new ManagedIdentityCredential({ clientId: cfg.AZURE_CLIENT_ID })
    : new DefaultAzureCredential();
  return credential;
}

export interface Secrets {
  readonly jwtSigningKey: Uint8Array;
}

/** Lee los secretos de Key Vault con identidad administrada. En local, de variables de entorno. */
export async function loadSecrets(cfg: Config): Promise<Secrets> {
  if (cfg.KEY_VAULT_URI) {
    const client = new SecretClient(cfg.KEY_VAULT_URI, azureCredential(cfg));
    const secret = await client.getSecret('jwt-signing-key');
    if (!secret.value || secret.value.length < 32) throw new Error('El secreto jwt-signing-key no es válido');
    return { jwtSigningKey: new TextEncoder().encode(secret.value) };
  }
  if (!cfg.JWT_SECRET) throw new Error('Falta JWT_SECRET (desarrollo) o KEY_VAULT_URI (Azure)');
  return { jwtSigningKey: new TextEncoder().encode(cfg.JWT_SECRET) };
}

/** Obtiene un token de Entra ID para un recurso (PostgreSQL, Redis). */
export async function getAccessToken(cfg: Config, scope: string): Promise<{ token: string; expiresOn: number }> {
  const t = await azureCredential(cfg).getToken(scope);
  if (!t) throw new Error(`No se pudo obtener token para ${scope}`);
  return { token: t.token, expiresOn: t.expiresOnTimestamp };
}
