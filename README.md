# Duelo de Magos — servidor de producción en Azure

Servidor **autoritativo** para un juego multijugador por turnos simultáneos (2 a 4 jugadores), con
muchas partidas independientes a la vez, desplegado en **Azure Container Apps** con infraestructura
como código, CI/CD y observabilidad.

El juego es el pretexto: lo que importa es el servidor. Valida cada jugada, es la única fuente de
verdad, mantiene cada partida consistente aunque los jugadores se desconecten, reintenten o una
réplica se reinicie, y nunca le envía a un jugador lo que no debe ver.

| | |
|---|---|
| **URL pública (dev)** | https://ca-duelo-dev.victoriousisland-0bfb0177.canadacentral.azurecontainerapps.io/play/ |
| **URL pública (prod)** | se publica al aprobar el despliegue a prod (ver Actions → Desplegar) |
| **Cliente de prueba** | `/play/` |
| **API REST (OpenAPI 3.1)** | `/docs` · [`contracts/openapi.yaml`](contracts/openapi.yaml) |
| **Tiempo real (AsyncAPI 3.0)** | `wss://…/v1/ws` · [`contracts/asyncapi.yaml`](contracts/asyncapi.yaml) |
| **Salud** | `/health/live` · `/health/ready` |

## El juego

Cada mago empieza con **12 de vida** y **2 de maná**, y tiene una **afinidad secreta** (fuego, agua
o tierra) que el servidor sortea con un generador criptográficamente seguro. En cada ronda **todos
eligen en secreto**, y la ronda se resuelve al cerrarse (o al vencer el temporizador):

| Acción | Costo | Efecto |
|---|---|---|
| **Atacar** a un mago con un elemento | 1 maná | 2 de daño · +1 si es tu afinidad · +2 si tu elemento vence al que usó el objetivo · +1 si el objetivo canalizaba |
| **Escudo** | 1 maná | Bloquea todo el daño; no se puede usar dos rondas seguidas |
| **Canalizar** | — | +2 maná (máx. 6). Acción por defecto si se agota el tiempo |

Agua apaga fuego, fuego calcina tierra, tierra absorbe agua. Gana el último mago en pie; si caen
todos a la vez es empate; tras 15 rondas gana quien tenga más vida. Desconectarse abre un periodo de
gracia; si no vuelve, el mago abandona (queda eliminado).
**Información oculta:** las jugadas pendientes y las afinidades de los demás nunca salen del servidor
hasta que corresponde (la ronda se resuelve o la partida termina).

## Correr localmente (menos de 10 minutos)

Requisitos: Docker Desktop (en Windows, con WSL 2).

```bash
git clone https://github.com/mauroza/duelo-magos.git
cd duelo-magos
docker compose up --build
```

Abre http://localhost:8080/play/ en dos ventanas (una normal y una de incógnito), crea dos cuentas y
juega. El ambiente local levanta **2 réplicas del servidor detrás de nginx**, PostgreSQL y Redis: cada
jugador puede quedar conectado a una réplica distinta y la partida funciona igual.

Para ver bots jugando contra el servidor local (requiere Node 20+ y `npm ci`):

```bash
npx tsx tools/bot.ts --url http://localhost:8080 --games 5
```

## Pruebas

```bash
npm ci
docker compose up -d postgres redis
npm test
```

52 pruebas: unitarias del dominio (reglas, daño, temporizadores, vista filtrada), de **integración**
con dos réplicas reales, de **concurrencia** (capacidad bajo uniones simultáneas, un jugador en una
sola partida, emparejamiento sin duplicados, idempotencia, `STALE_ROUND`), de **seguridad**
(tokens, tickets, origen, autorización por partida, información oculta, límites, administración),
de **resiliencia** (temporizadores, gracia, abandono, apagado ordenado con reconexión a otra réplica,
reinicio total) y de **contratos** (AsyncAPI y OpenAPI sincronizados con el código).

Otros comandos: `npm run lint` · `npm run typecheck` · `npm run build`.

## Prueba de carga

```bash
docker compose up -d postgres redis
npm run build
# servidor sin límites de autenticación para poder registrar miles de usuarios de prueba
RATE_LIMIT_AUTH_PER_MIN=100000 RATE_LIMIT_HTTP_PER_MIN=100000 JWT_SECRET=desarrollo-local-no-usar-en-produccion-0123456789 \
  DATABASE_URL=postgres://duelo:duelo-local-dev@localhost:5432/duelo REDIS_URL=redis://localhost:6379 node dist/main.js &
npx tsx load/loadtest.ts --url http://localhost:8080 --matches 25,50,100,200,300 --rounds 6 --pid $!
```

Resultados y análisis: [`docs/performance.md`](docs/performance.md).

## Despliegue en Azure

Todo se despliega con **GitHub Actions** y **Bicep**. No hay contraseñas, claves ni cadenas de
conexión: GitHub entra a Azure con OIDC, y el servidor usa identidad administrada para Key Vault,
PostgreSQL, el registro de contenedores y Application Insights. Redis es privado (VNet) y su contraseña vive en Key Vault.

1. Una sola vez, en Azure Cloud Shell: `infra/bootstrap-azure.sh` (crea los grupos de recursos y la
   identidad federada de GitHub).
2. En GitHub, crea las variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` y
   `AZURE_LOCATION`, y los ambientes `dev` y `prod` (prod con aprobación manual).
3. Cada push a `main` ejecuta: CI → **dev automático** → **prod con aprobación**. Un ambiente nuevo se
   levanta desde cero con una sola ejecución del pipeline.

Rollback en menos de 5 minutos: Actions → **Rollback** → elegir ambiente (o `scripts/rollback.sh prod`).
Detalles en [`docs/operations.md`](docs/operations.md).

## Documentación

| Documento | Contenido |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Arquitectura, flujo de una jugada y decisiones (ADR) |
| [`docs/threat-model.md`](docs/threat-model.md) | Modelo de amenazas (STRIDE) y controles |
| [`docs/performance.md`](docs/performance.md) | Prueba de carga, capacidad, punto de quiebre y optimizaciones |
| [`docs/operations.md`](docs/operations.md) | Despliegue, publicaciones sin cortar partidas, rollback, observabilidad y alertas |
| [`docs/cost.md`](docs/cost.md) | Estimación de costo mensual en Azure for Students |

## Estructura

```
src/domain/       reglas del juego: módulo puro, sin red, base de datos ni framework
src/app/          casos de uso: partidas, autenticación, emparejamiento, reloj del servidor
src/infra/        PostgreSQL, Redis, Key Vault, bus de eventos entre réplicas
src/transport/    HTTP (Fastify) y WebSocket (ws), validación de esquemas
src/observability OpenTelemetry → Application Insights, logs estructurados, métricas propias
contracts/        OpenAPI 3.1 y AsyncAPI 3.0
client/           cliente web de prueba
tools/            cliente TypeScript reutilizable y bot
load/             prueba de carga y resultados
infra/            Bicep (core + app) y configuración inicial de Azure
test/             unitarias e integración
```
