#!/usr/bin/env bash
# Muestra los errores de un despliegue de Azure como anotaciones de GitHub Actions.
# Uso: report-deploy-errors.sh <grupo> <despliegue> <archivo-stderr>
RG=$1; NAME=$2; ERR=$3
tr '\n' ' ' < "$ERR" | cut -c1-3000 | sed 's/^/::error title=az deployment::/'; echo
az deployment operation group list -g "$RG" -n "$NAME" \
  --query "[?properties.provisioningState=='Failed'].[properties.targetResource.resourceType, properties.targetResource.resourceName, properties.statusMessage.error.code, properties.statusMessage.error.message, to_string(properties.statusMessage.error.details)]" \
  -o tsv 2>/dev/null | while IFS=$'\t' read -r type name code msg details; do
    echo "::error title=$type $name::$code: $msg $details" | cut -c1-3000
  done
