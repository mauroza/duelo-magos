# Arquitectura

## Vista general

```
                 HTTPS / WSS
  Jugadores ───────────────────▶  Azure Container Apps (ingreso, TLS)
  (web, bot)                        │  revisiones múltiples, 1..3 réplicas
                                    ▼
                    ┌───────────────────────────────┐
                    │  Réplica del servidor (Node)  │  ×N, sin estado en memoria
                    │  transport ─▶ app ─▶ domain   │
                    └──────┬──────────────┬─────────┘
            identidad      │              │ identidad administrada
           administrada    ▼              ▼
          ┌────────────────────┐   ┌─────────────────────────┐
          │ PostgreSQL Flexible│   │ Azure Managed Redis     │
          │ estado confirmado, │   │ pub/sub entre réplicas, │
          │ bitácora, usuarios │   │ tickets, límites, cola, │
          └────────────────────┘   │ presencia               │
                                   └─────────────────────────┘
   Key Vault (secreto JWT) · Container Registry · Application Insights + Log Analytics
```

Cualquier réplica puede atender a cualquier jugador de cualquier partida. No hay afinidad de sesión.

## Capas

| Capa | Carpeta | Depende de | Responsabilidad |
|---|---|---|---|
| Dominio | `src/domain` | nada | Reglas: validar intenciones, resolver rondas, temporizadores, abandono, vista filtrada por jugador. Funciones puras `estado + comando → (estado, eventos)`. ESLint prohíbe importar red, base de datos o framework aquí. |
| Aplicación | `src/app` | dominio, puertos | Casos de uso: salas, jugadas, presencia, emparejamiento, reloj del servidor, autenticación. |
| Infraestructura | `src/infra` | — | PostgreSQL, Redis, Key Vault, bus de eventos. |
| Transporte | `src/transport` | aplicación | HTTP (Fastify) y WebSocket (`ws`). Valida cada mensaje con Zod antes de llegar al dominio. |

## Flujo de una jugada

1. El cliente envía `action.submit {matchId, clientMoveId, round, action}` por WebSocket.
2. La pasarela aplica el límite de tasa de la conexión, valida JSON, versión y esquema. Un mensaje
   inválido devuelve `error` sin cerrar la conexión ni tocar la partida.
3. `MatchService.submitAction` abre una transacción y ejecuta
   `SELECT … FROM matches WHERE id = $1 FOR UPDATE`. Ese bloqueo de fila serializa las jugadas de la
   misma partida aunque lleguen a réplicas distintas (**orden por partida**). En la misma consulta
   comprueba si ya existe `(partida, jugador, clientMoveId)` (**idempotencia**).
4. El dominio valida la intención: turno, ronda actual (`STALE_ROUND` si el estado avanzó), maná,
   objetivo y enfriamiento del escudo. Si todos jugaron, resuelve la ronda.
5. Una sola sentencia con CTE guarda los eventos (bitácora de solo inserción), la jugada, el nuevo
   estado y la nueva versión. Luego `COMMIT` (**durabilidad**: la jugada confirmada no se pierde).
6. Tras confirmar, publica `{matchId, fromSeq, toSeq, events}` en el canal Redis `match:<id>`.
7. Cada réplica con jugadores de esa partida filtra los eventos por destinatario (**vista por
   jugador**) y envía `match.update` solo con los cambios (**mensajes compactos**). Si un cliente ve
   un hueco en las secuencias, pide `match.subscribe` y recibe una vista completa (`match.sync`).

## Decisiones de arquitectura (ADR)

### ADR-1 · Estado confirmado en PostgreSQL con bloqueo de fila, en lugar de un actor en memoria
**Contexto:** las jugadas de una partida pueden llegar a réplicas distintas, y una réplica puede
reiniciarse en cualquier momento.
**Decisión:** la fila de la partida (estado JSONB + versión) es la única fuente de verdad. Cada
transición se hace dentro de una transacción con `FOR UPDATE`.
**Consecuencias:** orden estricto, durabilidad y supervivencia a reinicios sin coordinación extra.
El costo es una transacción por jugada. Se optimizó a 4 viajes a la base (ver `performance.md`) y
sostiene unas 300 partidas simultáneas por réplica con p95 < 200 ms.

### ADR-2 · Redis para difusión y estado efímero, no para el estado de la partida
**Decisión:** Redis transporta el pub/sub entre réplicas, los tickets de WebSocket, los límites de
tasa, la cola de emparejamiento y la presencia (con caducidad). Perder Redis no pierde jugadas: los
clientes se resincronizan desde PostgreSQL.

### ADR-3 · Turnos simultáneos con temporizador y acción por defecto
**Decisión:** todos eligen en secreto. La ronda se resuelve cuando todos los vivos jugaron o cuando
vence el plazo; quien no jugó, canaliza. El plazo se guarda en la columna `deadline`. Un barrido en
cada réplica usa `FOR UPDATE SKIP LOCKED`, así el reloj sobrevive reinicios y el trabajo se reparte
sin duplicarse.

### ADR-4 · Eventos de dominio con destinatario
**Decisión:** cada evento lleva `to: 'all' | <jugador>`. `affinity.assigned` es privado y
`action.accepted` solo dice **quién** jugó, nunca **qué**. La pasarela filtra por conexión. La vista
completa (`playerView`) también se construye por jugador. Hay pruebas que verifican que ningún
mensaje filtra información oculta.

### ADR-5 · Autenticación propia con JWT corto y refresh rotativo
**Decisión:** JWT HS256 de 15 minutos firmados con un secreto de Key Vault, y refresh tokens opacos
de un solo uso, guardados como hash. Reutilizar uno ya rotado revoca toda la familia. Contraseñas con
Argon2id (parámetros OWASP). El WebSocket se autentica con un ticket de un solo uso de 30 s
(`GETDEL` en Redis), para no poner el JWT en la URL.

### ADR-6 · Azure Container Apps con revisiones múltiples
**Decisión:** Container Apps (consumo), con `activeRevisionsMode: Multiple`. Cada despliegue crea
una revisión nueva que recibe el tráfico, y luego se desactiva la anterior. Esa revisión cierra sus
WebSockets con el código 4012 y los clientes reconectan a la nueva. Como el estado vive en
PostgreSQL, las partidas continúan. El rollback es pasar el tráfico a la revisión anterior.

### ADR-7 · Azure Managed Redis en lugar de Azure Cache for Redis
Azure Cache for Redis está en retiro. Azure Managed Redis (Balanced B0) admite autenticación solo con
Entra ID (`accessKeysAuthentication: Disabled`). Las claves del emparejamiento usan *hash tags*
(`{mm}:…`) para que el script atómico funcione con la política de clúster.

### ADR-8 · Protocolo JSON versionado
JSON es legible, fácil de depurar y suficiente para el tamaño de los mensajes: 357 B en promedio
gracias a los eventos mínimos. Cada mensaje lleva `v: 1`, y una versión desconocida recibe
`UNSUPPORTED_VERSION`. MessagePack queda como mejora futura si el ancho de banda se vuelve el
cuello de botella.

## Ciclo de vida de una partida

```
lobby ──(todos listos, ≥2)──▶ active ──(1 vivo / 0 vivos / máx. rondas)──▶ finished
  │                             │
  └─(TTL de inactividad / vacía)┴─(admin)──────────────────────────────────▶ aborted
```

Al terminar, se liberan las membresías activas (`active_membership`) y la fila queda **inmutable**:
un trigger impide modificar partidas terminadas, y `match_events` y `audit_log` son de solo inserción.
