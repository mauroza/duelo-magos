# Modelo de amenazas (STRIDE)

**Activos:** cuentas y sesiones, integridad de las partidas (resultado justo e inmutable),
información oculta (jugadas pendientes y afinidades), disponibilidad del servicio y secretos.

**Fronteras de confianza:** navegador o bot ↔ ingreso de Azure (TLS) ↔ réplica ↔ PostgreSQL, Redis y
Key Vault (red de Azure + identidad administrada) ↔ GitHub Actions (OIDC).

| # | Amenaza | STRIDE | Control | Verificación |
|---|---|---|---|---|
| 1 | Robo de contraseñas desde la base | I | Argon2id (19 MiB, t=2); se compara contra un hash ficticio para no revelar si el usuario existe | `auth-service.ts` |
| 2 | Fuerza bruta de inicio de sesión | S, D | Límite de 10/min por IP en `/v1/auth/*` (429 + `Retry-After`) | `security.test.ts` |
| 3 | Robo de un refresh token | S | Rotación en cada uso; reutilizar uno ya usado revoca toda la familia (`TOKEN_REUSED`); solo se guarda el hash SHA-256 | `security.test.ts` |
| 4 | JWT falsificado o expirado | S | HS256 con secreto de 48 bytes en Key Vault; se validan emisor, audiencia y expiración (15 min) | `security.test.ts` |
| 5 | JWT expuesto en URL o logs al abrir el WebSocket | I | Ticket de un solo uso de 30 s (`GETDEL`); los logs censuran `authorization`, `password`, `ticket` y `refreshToken` | `security.test.ts` |
| 6 | Secuestro de WebSocket entre sitios (CSWSH) | S | Lista de orígenes permitidos; otro origen se cierra con 4003 | `security.test.ts` |
| 7 | Jugar en nombre de otro | S, E | El jugador sale del ticket de la conexión, nunca del mensaje | `security.test.ts` |
| 8 | Actuar en una partida ajena | E | Cada endpoint y cada mensaje verifican participación (`NOT_A_PARTICIPANT`) | `security.test.ts` |
| 9 | Jugar fuera de turno o con datos falsos ("ahora tengo 10 puntos") | T | Servidor autoritativo: el cliente envía intenciones y el dominio valida todo contra el estado | `rules.test.ts` |
| 10 | Reenvío o duplicado de jugadas (*replay*) | T | `clientMoveId` único por jugador y partida; ronda explícita (`STALE_ROUND`) | `concurrency.test.ts` |
| 11 | Ver la jugada o afinidad de otro (trampa por información oculta) | I | Eventos con destinatario; `action.accepted` no revela la acción; la vista se filtra por jugador; la repetición solo muestra eventos propios o públicos | `security.test.ts`, `rules.test.ts` |
| 12 | Predecir el azar | T | Afinidades con `crypto.randomInt` (CSPRNG) en el servidor | `match-service.ts` |
| 13 | Manipular el reloj | T | Temporizadores en el servidor y guardados en la base; el cliente solo muestra la cuenta regresiva | `resilience.test.ts` |
| 14 | Mensajes enormes o malformados | D | Máximo de 4 KiB por mensaje WS (se cierra con 1009) y 16 KiB por cuerpo HTTP; validación Zod estricta (`.strict()`) | `security.test.ts` |
| 15 | Inundación de mensajes | D | Token bucket de 10 msg/s con ráfaga de 20 por conexión; 120 req/min HTTP por usuario | `security.test.ts` |
| 16 | Agotar conexiones | D | Máximo de 3 WebSockets por usuario (4009); heartbeat que cierra conexiones muertas (4011) | `security.test.ts` |
| 17 | Una partida rota tumba el proceso | D | Cada transición es una transacción aislada; errores por partida capturados; el barrido continúa | `resilience.test.ts` |
| 18 | Abuso de administración | E, R | Rol `admin` en el JWT y endpoints con `requireAdmin`; cada acción se guarda en `audit_log` (solo inserción, protegida con trigger) | `security.test.ts` |
| 19 | Alterar resultados o historial | T, R | Trigger: una partida terminada es inmutable; `match_events` es de solo inserción | migración `001_init.sql` |
| 20 | Secretos filtrados en el repositorio | I | Ningún secreto en el repo: gitleaks en CI; Key Vault con RBAC; producción rechaza `JWT_SECRET` por variable | CI, `config.ts` |
| 21 | Credenciales entre servicios | S, I | Identidad administrada para PostgreSQL (solo Entra), ACR, Key Vault y App Insights (`DisableLocalAuth`). Redis: solo red interna (VNet) y contraseña aleatoria de Key Vault entregada con identidad administrada | `infra/*.bicep` |
| 22 | Credenciales del pipeline | S, E | OIDC federado (sin secretos en GitHub); la identidad de despliegue solo es Owner de los grupos `dev` y `prod` | `bootstrap-azure.sh` |
| 23 | Dependencias o imagen vulnerables | T | `npm audit` (alta y crítica), CodeQL, Dependabot y Trivy (crítica); la imagen corre como usuario `node`, no root | CI |
| 24 | Ataques del navegador (XSS, *clickjacking*, *sniffing*) | T, I | Helmet: CSP `default-src 'self'`, HSTS, `nosniff`, `frame-ancestors`; el cliente escapa todo texto de usuarios | `security.test.ts` |
| 25 | Tráfico sin cifrar | I | Solo HTTPS y WSS (`allowInsecure: false`); TLS 1.2+ hacia Redis y PostgreSQL | `app.bicep` |

## Riesgos aceptados

- **PostgreSQL con acceso público restringido a servicios de Azure** (regla `0.0.0.0`), en lugar de
  una red privada (VNet). Así se mantiene el costo dentro del crédito de estudiante. La autenticación
  es solo con Entra ID y no existen contraseñas, por lo que una conexión externa no puede
  autenticarse. Mitigación futura: integración con VNet y endpoint privado.
- **Valores de desarrollo en el repositorio** (`docker-compose.yml`, pruebas): son credenciales
  ficticias, sin acceso a nada real. Producción las rechaza y están documentadas en `.gitleaks.toml`.
