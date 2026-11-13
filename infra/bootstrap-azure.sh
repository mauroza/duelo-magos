#!/usr/bin/env bash
# Configuración inicial de Azure, una sola vez.
# Ejecutar en Azure Cloud Shell (portal.azure.com -> ícono >_ -> Bash):
#   curl -fsSL https://raw.githubusercontent.com/mauroza/duelo-magos/main/infra/bootstrap-azure.sh | bash
#
# Crea los grupos de recursos dev y prod, y una identidad administrada que GitHub Actions
# usa mediante OIDC (credencial federada). No se crea ni se guarda ninguna contraseña o clave.
set -euo pipefail

REPO="${REPO:-mauroza/duelo-magos}"
LOCATION="${LOCATION:-}"
PREFIX="${PREFIX:-duelo-magos}"

SUB=$(az account show --query id -o tsv)
TENANT=$(az account show --query tenantId -o tsv)
echo "Suscripción: $(az account show --query name -o tsv) ($SUB)"

# Azure for Students restringe las regiones con una política. Se detectan las permitidas.
ALLOWED=$(az policy assignment list --query "[].parameters.listOfAllowedLocations.value[]" -o tsv 2>/dev/null | sort -u || true)
if [ -n "$ALLOWED" ]; then
  echo "Regiones permitidas por tu suscripción: $(echo $ALLOWED | tr '\n' ' ')"
fi
if [ -z "$LOCATION" ]; then
  for pref in eastus centralus southcentralus westus2 westus3 northcentralus canadacentral brazilsouth mexicocentral eastus2 westeurope northeurope; do
    if [ -z "$ALLOWED" ] || echo "$ALLOWED" | grep -qx "$pref"; then LOCATION="$pref"; break; fi
  done
  [ -z "$LOCATION" ] && LOCATION=$(echo "$ALLOWED" | head -n1)
fi
echo "Región elegida: $LOCATION"

echo "Registrando proveedores de recursos (puede tardar unos minutos)..."
for ns in Microsoft.App Microsoft.OperationalInsights Microsoft.Insights Microsoft.ContainerRegistry \
          Microsoft.KeyVault Microsoft.DBforPostgreSQL Microsoft.Cache Microsoft.ManagedIdentity; do
  az provider register --namespace "$ns" --wait >/dev/null
done

# Si el grupo ya existe (por un intento anterior) se reutiliza: su región no limita la de los recursos.
for g in dev prod cicd; do
  if [ "$(az group exists -n "rg-$PREFIX-$g")" != "true" ]; then
    az group create -n "rg-$PREFIX-$g" -l "$LOCATION" -o none
  fi
done

ID_NAME="id-$PREFIX-github"
az identity create -g "rg-$PREFIX-cicd" -n "$ID_NAME" -l "$LOCATION" -o none
CLIENT_ID=$(az identity show -g "rg-$PREFIX-cicd" -n "$ID_NAME" --query clientId -o tsv)
PRINCIPAL_ID=$(az identity show -g "rg-$PREFIX-cicd" -n "$ID_NAME" --query principalId -o tsv)

# Owner sobre cada grupo: el Bicep asigna roles (AcrPull, Key Vault Secrets User) a la identidad del servidor.
for env in dev prod; do
  az role assignment create --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
    --role Owner --scope "/subscriptions/$SUB/resourceGroups/rg-$PREFIX-$env" -o none || true
done

# Credenciales federadas: GitHub Actions obtiene un token de Azure sin secretos.
# GitHub puede emitir el "subject" en formato clásico (repo:dueño/repo:...) o con IDs inmutables
# (repo:dueño@ID/repo@ID:...); se registran ambos.
IDS=$(curl -fsSL "https://api.github.com/repos/$REPO" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f\"{d['owner']['login']}@{d['owner']['id']}/{d['name']}@{d['id']}\")" || true)
SUBJECTS=()
for base in "$REPO" $IDS; do
  for s in ref:refs/heads/main environment:dev environment:prod; do SUBJECTS+=("repo:$base:$s"); done
done
for subject in "${SUBJECTS[@]}"; do
  name=$(echo "$subject" | tr ':/.@' '----' | cut -c1-120)
  az identity federated-credential create -g "rg-$PREFIX-cicd" --identity-name "$ID_NAME" -n "$name" \
    --issuer https://token.actions.githubusercontent.com --subject "$subject" \
    --audiences api://AzureADTokenExchange -o none 2>/dev/null || echo "  (ya existía: $subject)"
done

cat <<EOF

==================================================================
Listo. En GitHub: $REPO -> Settings -> Secrets and variables -> Actions
-> pestaña "Variables" -> "New repository variable" y crea estas 4:

  AZURE_CLIENT_ID        = $CLIENT_ID
  AZURE_TENANT_ID        = $TENANT
  AZURE_SUBSCRIPTION_ID  = $SUB
  AZURE_LOCATION         = $LOCATION

(No son secretos: identifican la identidad, pero no dan acceso por sí solos.)
==================================================================
EOF
