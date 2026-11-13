# Operación

## Pipeline

```
push a main ──▶ CI ──▶ dev (automático) ──▶ prod (aprobación manual en GitHub)
                │        │                    │
                │        └ core.bicep → secreto JWT → imagen → app.bicep → prueba de humo → drenado
                └ lint · tipos · unitarias · integración (Postgres y Redis reales) · AsyncAPI · OpenAPI
                  · npm audit · gitleaks · imagen no root · Trivy · Bicep · CodeQL (workflow aparte)
```

- **Autenticación en Azure:** OIDC (`azure/login`) con una identidad administrada federada. No hay
  secretos en GitHub; solo variables con identificadores.
- **Ambiente desde cero:** una ejecución del pipeline crea Log Analytics, App Insights, la identidad,
  ACR, Key Vault, PostgreSQL, Redis, el entorno de Container Apps, el secreto JWT, la imagen, la app y
  las alertas. El único requisito previo es el grupo de recursos (`infra/bootstrap-azure.sh`).
- **Prueba de humo:** tras desplegar, `/health/ready` y una partida completa entre dos bots
  (`tools/bot.ts`) contra la URL pública.

## Publicaciones sin cortar partidas

1. `app.bicep` crea una **revisión nueva**. Container Apps está en modo `Multiple`, y la revisión
   nueva recibe el 100 % del tráfico nuevo.
2. La revisión anterior sigue viva con sus WebSockets abiertos. El pipeline la **desactiva**.
3. Al recibir `SIGTERM`, la réplica vieja:
   - deja de estar lista (`/health/ready` responde 503),
   - cierra cada WebSocket con **4012 «server restarting, please reconnect»**,
   - espera hasta 15 s de drenado y libera conexiones.
4. Los clientes reconectan de inmediato (el web reintenta en 300 ms al recibir 4012). Llegan a la
   revisión nueva, se suscriben de nuevo y reciben `match.sync`.
5. Las partidas continúan: el estado y los temporizadores están en PostgreSQL. El periodo de gracia
   (30 s) cubre la reconexión, y ninguna jugada confirmada se pierde. La prueba
   `resilience.test.ts › si una réplica se apaga…` reproduce este escenario.

## Rollback (menos de 5 minutos)

**Opción A — GitHub:** Actions → **Rollback** → *Run workflow* → ambiente (y revisión opcional).

**Opción B — terminal** (Cloud Shell):

```bash
./scripts/rollback.sh prod            # vuelve a la revisión anterior
./scripts/rollback.sh prod <revisión> # o a una concreta
```

El script reactiva la revisión destino, espera a que esté `Running`, le pasa el 100 % del tráfico y
desactiva la actual con el mismo cierre ordenado. Imprime el tiempo total; lo habitual es 1 a 2
minutos.

Para listar revisiones:

```bash
az containerapp revision list -n ca-duelo-prod -g rg-duelo-magos-prod -o table --all
```

## Observabilidad

- **Trazas, métricas y logs:** OpenTelemetry (`@azure/monitor-opentelemetry`) hacia Application
  Insights, autenticado con identidad administrada (`DisableLocalAuth: true`). Se instrumentan
  automáticamente HTTP, PostgreSQL y Redis.
- **Logs estructurados (JSON, pino)** con `traceId`, `spanId`, `instance`, `matchId` y `userId`.
  Nunca incluyen contraseñas, tokens, tickets ni el encabezado `Authorization` (se censuran).
- **Métricas propias:**

| Métrica | Tipo | Descripción |
|---|---|---|
| `game.matches.active` | gauge | Partidas en curso (todo el sistema) |
| `game.ws.connections` | up/down | WebSockets abiertos por réplica |
| `game.actions` | contador | Jugadas procesadas (`result=accepted\|duplicate`) |
| `game.action.latency` | histograma (ms) | Llegada de la jugada → confirmación, y → difusión (`stage=broadcast`) |
| `game.rounds.resolved` | contador | Rondas resueltas |
| `game.matches.finished` | contador | Partidas terminadas, por motivo |
| `game.rate_limited` | contador | Rechazos por límite de tasa (`transport=http\|ws`) |

- **Sondas:** `/health/live` (el proceso responde) y `/health/ready` (PostgreSQL y Redis accesibles,
  y la réplica no está drenando). Container Apps usa ambas, más una sonda de arranque.

## Alertas (`infra/app.bicep`)

| Alerta | Condición | Severidad |
|---|---|---|
| Latencia por jugada | promedio de `game.action.latency` > 200 ms en 5 min | 2 |
| Errores HTTP | 5xx > 1 % de las solicitudes en 5 min (con al menos 20) | 1 |
| Reinicios | más de 3 eventos `BackOff`/`ContainerTerminated` en 15 min | 2 |

Para recibir correos, pasa el parámetro `alertEmail` en `app.bicep`.

## Tareas de administración

Para promover un administrador desde Cloud Shell o un contenedor con identidad:

```bash
npx tsx tools/promote-admin.ts <usuario>
```

Endpoints de administración (todos auditados):
- `GET /v1/admin/matches`
- `GET /v1/admin/connections`
- `POST /v1/admin/matches/{id}/terminate`
- `POST /v1/admin/users/{id}/suspend`
- `POST /v1/admin/users/{id}/reinstate`
- `GET /v1/admin/audit`
