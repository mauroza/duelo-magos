# Cumplimiento de requisitos

Mapa entre cada requisito del enunciado y dónde se cumple: código, prueba o documento.

## El juego

| Restricción | Cumplimiento |
|---|---|
| Por turnos | Turnos simultáneos: todos eligen en secreto y la ronda se resuelve al cerrarse o al vencer el temporizador (`src/domain/rules.ts`). |
| Multijugador | 2 a 4 magos humanos por partida (`DEFAULT_CONFIG`). |
| Original | Reglas propias: vida, maná, escudo con enfriamiento, elección de objetivo, afinidad secreta y bonificación por contrahechizo. No es una recreación 1 a 1 de otro juego. |
| Reglas verificables | El dominio decide sin ambigüedad la validez de cada jugada y el fin de la partida (`validateAction`, `resolveRound`, `checkEnd`). 16 pruebas unitarias. |
| Información oculta | Jugadas pendientes y afinidades secretas: nunca se envían a otro jugador (`playerView`, eventos con destinatario). |

## Requisitos funcionales

| Capacidad | Dónde | Prueba |
|---|---|---|
| Usuarios: registro, sesión, refresh rotativo, perfil | `POST /v1/auth/*`, `GET/PATCH /v1/users/me` | `security.test.ts` |
| Salas públicas o privadas, listar, unirse, salir, «listo»; inicia con 2 o más listos; capacidad bajo concurrencia | `/v1/matches*` | `concurrency.test.ts`, `gameplay.test.ts` |
| Emparejamiento: un jugador nunca en dos partidas; espera máxima configurable | `Matchmaker` (líder en Redis, extracción atómica) + `active_membership` | `concurrency.test.ts` |
| Turnos: solo juega quien corresponde, error tipado, temporizador con acción por defecto | `action.submit` (AsyncAPI) | `rules.test.ts`, `resilience.test.ts` |
| Conexión: heartbeat, reconexión, gracia configurable y abandono | `Gateway`, `GRACE_MS` | `resilience.test.ts` |
| Fin de partida: resultado inmutable y repetición jugada por jugada | trigger `matches_immutable`, `GET /v1/matches/{id}/replay` | `gameplay.test.ts` |
| Historial paginado; cada quien ve solo lo suyo | `GET /v1/history` | `gameplay.test.ts` |
| Administración (solo admin y auditada) | `/v1/admin/*`, `audit_log` | `security.test.ts` |

## Reglas del servidor

| Regla | Cómo |
|---|---|
| Autoritativo | El cliente envía intenciones (`{kind:'attack', element, target}`); el servidor valida y calcula todo. |
| Orden por partida + secuencia | `SELECT … FOR UPDATE` por partida; cada evento lleva `seq`; una jugada sobre una ronda vieja se rechaza con `STALE_ROUND`. |
| Idempotencia | `clientMoveId` único por jugador y partida; un reenvío devuelve `ack` con `duplicate: true`. |
| Vista por jugador | `playerView` y filtrado de eventos por destinatario; la repetición solo muestra eventos públicos o propios. |
| Durabilidad | Estado y bitácora en PostgreSQL dentro de la transacción; las partidas sobreviven a reinicios (prueba de reinicio total). |
| Aislamiento | Cada transición es una transacción independiente; los errores se capturan por partida. |
| Limpieza | Salas inactivas expiran (TTL); al terminar se liberan las membresías. |
| Reloj y azar del servidor | Plazos guardados en la base y barridos con `SKIP LOCKED`; afinidades con `crypto.randomInt`. |

## Requisitos técnicos

| Requisito | Cumplimiento |
|---|---|
| Lenguaje tipado estricto | TypeScript con `strict`, `noUncheckedIndexedAccess` y ESLint `strictTypeChecked` (`no-explicit-any: error`); Node 22. |
| Dominio puro | `src/domain` no importa red, base de datos ni framework (lo impone ESLint). |
| Tiempo real WSS sin sondeo | WebSocket (`ws`) en `/v1/ws`; el servidor empuja `match.update`. |
| Protocolo versionado en AsyncAPI 3.0 | `contracts/asyncapi.yaml` (validado en CI); sobre `{v:1,…}`. |
| API REST en OpenAPI 3.1 en `/docs` | `contracts/openapi.yaml` (validado con Redocly en CI); Swagger UI en `/docs`. |
| Problem Details (RFC 9457) | `problem.ts`: `application/problem+json`. |
| Validación de mensajes antes del dominio | Zod estricto; un mensaje inválido recibe `error` sin cerrar la partida. |
| Heartbeat y cierre con códigos documentados | ping/pong; códigos 4001, 4003, 4008–4012 en AsyncAPI. |
| Autenticación | JWT firmado con secreto de Key Vault; Argon2id; ticket de un solo uso en el handshake WebSocket. |
| Autorización | Por endpoint y por mensaje: participante, turno y rol admin. |
| Límites | 429 con `Retry-After`; tasa por conexión WebSocket; tamaño máximo; máximo de conexiones por usuario. |
| Transporte | Solo HTTPS/WSS; CORS y orígenes WebSocket restringidos; Helmet (CSP, HSTS, `nosniff`). |
| Secretos | Key Vault con identidad administrada; ninguno en el repositorio (gitleaks en CI). |
| Cadena de suministro | Dependabot, CodeQL, gitleaks, `npm audit`; imagen con usuario `node`, sin vulnerabilidades críticas (Trivy). |
| Prueba de carga y metas | p95 de 139 ms con 200 partidas; 0 perdidas y 0 duplicadas; 0 % de error (`docs/performance.md`). |
| Capacidad y punto de quiebre | Unas 300 partidas por réplica; ~0,3 MB por partida activa. |
| Mensajes compactos | Eventos delta: 357 B contra 620 B de la vista completa (−42 %). |
| Optimización medida | De 7 a 4 viajes a la base: p95 −33 %, punto de quiebre +50 %. |
| IaC | Bicep (`infra/core.bicep`, `infra/app.bicep`); ambiente nuevo con una ejecución del pipeline. |
| CI/CD | GitHub Actions: CI → dev automático → prod con aprobación manual. |
| Publicaciones sin cortar partidas y rollback | Revisiones múltiples, drenado con código 4012, `scripts/rollback.sh` y workflow Rollback. |
| Identidad administrada | ACR, Key Vault, PostgreSQL (solo Entra), App Insights (sin claves locales); OIDC para GitHub. |
| Observabilidad | OpenTelemetry → Application Insights; logs con `matchId` y `userId`; métricas propias; `/health/live` y `/health/ready`; 3 alertas. |
| Costo | `docs/cost.md`; dev escala a cero. |
