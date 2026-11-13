/**
 * Promueve un usuario a administrador (operación de arranque, no expuesta por la API).
 *   DATABASE_URL=postgres://... npx tsx tools/promote-admin.ts <username>
 * En Azure se ejecuta con la identidad administrada (AUTH_MODE=azure, PGHOST, PGUSER).
 */
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/infra/db.js';

const username = process.argv[2];
if (!username) {
  console.error('Uso: tools/promote-admin.ts <username>');
  process.exit(1);
}
const db = createPool(loadConfig({ ...process.env, NODE_ENV: 'development' }));
const res = await db.query("UPDATE users SET role = 'admin' WHERE username = $1 RETURNING id", [username]);
console.log(res.rowCount === 1 ? `${username} ahora es administrador` : `No existe el usuario ${username}`);
await db.end();
