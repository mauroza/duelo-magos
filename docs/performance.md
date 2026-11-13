# Rendimiento y optimización

## Metodología

- **Script:** [`load/loadtest.ts`](../load/loadtest.ts). Es reproducible: los comandos están en el README.
- **Escenario:** N partidas simultáneas de 2 jugadores (2N WebSockets). Cada una juega 6 rondas sin
  pausa, con decisiones del bot (`chooseAction`).
- **Métrica principal:** por ronda, el tiempo desde que se envía la jugada que **cierra** la ronda
  hasta que **todos** los jugadores de la partida reciben `round.resolved`. Es la latencia de punta a
  punta que pide la meta (jugada → todos tienen el nuevo estado).
- **Integridad:** se cuentan las rondas que algún jugador nunca recibió (**perdidas**) y las que
  recibió más de una vez (**duplicadas**).
- **Recursos:** CPU (% de un núcleo) y RSS máximo del proceso del servidor, leídos de `/proc/<pid>`.
- **Entorno:** 1 réplica (`node dist/main.js`) con PostgreSQL 16 y Redis 7 en Docker, en una máquina
  de 4 vCPU. El generador de carga corre en la **misma** máquina y compite por CPU, así que los
  números son conservadores. Los resultados crudos están en [`load/results/`](../load/results).

**Metas:** p95 < 200 ms · 0 jugadas perdidas o duplicadas · error < 1 %.

## Resultado final (versión optimizada, 1 réplica)

| Partidas | Conexiones | Rondas medidas | p50 | **p95** | p99 | Error | Perdidas | Duplicadas | B/mensaje | CPU | RSS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 25 | 50 | 141 | 20 ms | **36 ms** | 46 ms | 0 % | 0 | 0 | 351 | 88 % | 149 MB |
| 50 | 100 | 258 | 32 ms | **55 ms** | 60 ms | 0 % | 0 | 0 | 355 | 82 % | 156 MB |
| 100 | 200 | 511 | 70 ms | **88 ms** | 93 ms | 0 % | 0 | 0 | 356 | 65 % | 161 MB |
| 200 | 400 | 1029 | 113 ms | **139 ms** | 149 ms | 0 % | 0 | 0 | 357 | 66 % | 201 MB |
| 300 | 600 | 1527 | 165 ms | **204 ms** | 211 ms | 0 % | 0 | 0 | 357 | 59 % | 235 MB |

✅ Se cumplen las metas hasta **~290 partidas simultáneas por réplica** (580 conexiones).

**Punto de quiebre:** unas **300 partidas por réplica**, donde el p95 alcanza 204 ms. Más allá la
latencia crece linealmente, pero el sistema **no pierde ni duplica jugadas y no produce errores**:
se degrada en latencia, no en correctitud.

**Costo por partida activa:** unos **0,3 MB de RSS** (de 149 MB a 235 MB al pasar de 25 a 300
partidas) y unos **0,25 ms de CPU por jugada** en el servidor. El perfil de CPU (`node --cpu-prof`)
mostró que el tiempo restante se va sobre todo en E/S de sockets (`writev`) hacia PostgreSQL, Redis
y los clientes.

**Escalado:** como el estado vive en PostgreSQL y la difusión pasa por Redis, la capacidad crece
agregando réplicas. Container Apps escala de 1 a 3 réplicas en prod. En Azure cada réplica tiene
0,5 vCPU, así que su punto de quiebre esperado es menor (estimado entre 120 y 150 partidas). Con 3
réplicas, entre 360 y 450 partidas.

## Optimización 1 · Menos viajes a la base por jugada (latencia)

**Hipótesis:** el perfil mostraba mucho tiempo en `writev` y una latencia que crecía en forma lineal
con la carga. Cada jugada hacía **7 viajes** a PostgreSQL: `BEGIN`, `SELECT … FOR UPDATE`, `SELECT`
de idempotencia, `INSERT` de eventos, `UPDATE` de la partida, `INSERT` de la jugada y `COMMIT`.

**Cambio** (commit `perf: jugadas con 4 viajes…`):
- La comprobación de idempotencia viaja como subconsulta dentro del mismo `SELECT … FOR UPDATE`.
- Eventos, jugada, nuevo estado y liberación de membresías se escriben en **una sola sentencia** con
  CTE de escritura.
- Total: **4 viajes** (`BEGIN`, `SELECT`, `WITH … UPDATE`, `COMMIT`).
- Un caso límite (reenvíos simultáneos de la misma jugada) se resolvió con una segunda consulta que
  solo se ejecuta en ese caso. La prueba de idempotencia lo cubre.

| Partidas | p95 antes | **p95 después** | Cambio |
|---|---|---|---|
| 25 | 38 ms | 36 ms | −5 % |
| 50 | 55 ms | 55 ms | = |
| 100 | 82 ms | 88 ms | ruido |
| 200 | 209 ms ❌ | **139 ms ✅** | **−33 %** |
| 300 | — (ya había quebrado) | 204 ms | — |

**Punto de quiebre: de ~200 a ~300 partidas por réplica (+50 %).**
Archivos: `load/results/delta-*.json` (antes) y `load/results/optimizado-*.json` (después).

## Optimización 2 · Mensajes compactos (ancho de banda)

**Línea base (`BROADCAST_MODE=full`):** tras cada cambio se envía la vista completa de la partida a
cada jugador. **Optimizado (`delta`, por defecto):** solo se envían los eventos nuevos, filtrados por
jugador. El cliente aplica los cambios y se resincroniza solo si detecta un hueco de secuencia.

| Modo | Bytes por mensaje | p95 con 100 partidas | p95 con 200 partidas |
|---|---|---|---|
| full (antes) | 620 B | 98 ms | 162 ms |
| **delta (después)** | **357 B (−42 %)** | 82 ms | 209 ms* |

\* Medido antes de la optimización 1. La latencia no cambia de forma significativa: el cuello de
botella no era la red, sino la base de datos. Por eso la optimización 1 fue la que movió el punto de
quiebre. El beneficio de `delta` es el ancho de banda: **42 % menos bytes** por jugador y por cambio,
lo que importa en conexiones móviles. Además, `full` incluye el estado completo en cada mensaje de
pub/sub entre réplicas.

## Cómo reproducir

```bash
# antes de la optimización 1
git checkout 036d3a3 && npm ci && npm run build
# después
git checkout main && npm run build
# en ambos casos (ver README para variables), opcionalmente con BROADCAST_MODE=full:
node dist/main.js & npx tsx load/loadtest.ts --matches 25,50,100,200,300 --rounds 6 --pid $!
```
