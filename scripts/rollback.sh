#!/usr/bin/env bash
# Uso: scripts/rollback.sh <dev|prod> [revisión]
# Reactiva la revisión destino, espera a que esté lista, le pasa el 100 % del tráfico y
# desactiva la actual (cierre ordenado: los clientes reconectan y las partidas continúan).
set -euo pipefail
ENV="${1:?ambiente}"; TARGET="${2:-}"
APP="ca-duelo-$ENV"; RG="rg-duelo-magos-$ENV"
start=$(date +%s)
CURRENT=$(az containerapp ingress traffic show -n "$APP" -g "$RG" --query "[?weight==\`100\`].revisionName | [0]" -o tsv)
if [ -z "$CURRENT" ] || [ "$CURRENT" = "None" ]; then
  CURRENT=$(az containerapp show -n "$APP" -g "$RG" --query properties.latestRevisionName -o tsv)
fi
if [ -z "$TARGET" ]; then
  TARGET=$(az containerapp revision list -n "$APP" -g "$RG" --all \
    --query "sort_by([?name!='$CURRENT'], &properties.createdTime)[-1].name" -o tsv)
fi
echo "Rollback $ENV: $CURRENT -> $TARGET"
az containerapp revision activate -n "$APP" -g "$RG" --revision "$TARGET" -o none
for i in $(seq 1 30); do
  state=$(az containerapp revision show -n "$APP" -g "$RG" --revision "$TARGET" --query properties.runningState -o tsv)
  [ "$state" = "Running" ] && break; sleep 5
done
az containerapp ingress traffic set -n "$APP" -g "$RG" --revision-weight "$TARGET=100" -o none
az containerapp revision deactivate -n "$APP" -g "$RG" --revision "$CURRENT" -o none
echo "Rollback completo en $(( $(date +%s) - start )) s"
