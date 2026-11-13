# Estimación de costo mensual (Azure for Students, Canada Central)

Precios de lista aproximados en USD, que pueden variar; se verifican con la
[calculadora de Azure](https://azure.microsoft.com/pricing/calculator/). El crédito de Azure for
Students es de **USD 100**.

| Recurso | SKU | prod (24/7) | dev |
|---|---|---|---|
| Container Apps | Consumo, 0,5 vCPU / 1 GiB; prod mín. 1 réplica, dev escala a 0 | ~$10–15* | ~$0–2 |
| PostgreSQL Flexible | Burstable B1ms, 32 GB | ~$15 | ~$15 (o $0 si se detiene) |
| Azure Managed Redis | Balanced B0 | ~$15–20 | ~$15–20 |
| Container Registry | Basic | $5 | $5 |
| Key Vault | Standard, pocas operaciones | < $1 | < $1 |
| Log Analytics + App Insights | límite diario de 1 GB (prod) y 0,3 GB (dev) | ~$2–5 | ~$1 |
| **Total aproximado** | | **~$48–61 / mes** | **~$36–43 / mes** |

\* La concesión gratuita mensual de Container Apps (180 000 vCPU·s y 360 000 GiB·s) cubre gran parte
de una réplica de 0,5 vCPU encendida todo el mes.

## Cómo mantenerse dentro del crédito

- **dev escala a cero** (`minReplicas: 0`) cuando no hay tráfico.
- **Apagar dev cuando no se usa:**
  ```bash
  az postgres flexible-server stop -g rg-duelo-magos-dev -n <servidor>
  ```
  PostgreSQL se puede detener hasta 7 días seguidos. Redis no se puede detener: si hace falta, se
  elimina el ambiente dev y se recrea con el pipeline (un solo clic).
- **Fuera del periodo de revisión**, eliminar el grupo `rg-duelo-magos-dev` deja el costo de prod en
  ~$50/mes. El pipeline vuelve a crear dev desde cero cuando haga falta.
- Los límites diarios de ingesta de Log Analytics evitan sorpresas por exceso de logs.
- **Alerta de presupuesto recomendada:** en el portal, Cost Management → Budgets → USD 40/mes con
  aviso al 80 %.
