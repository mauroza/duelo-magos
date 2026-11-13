// Infraestructura base de un ambiente (dev o prod). Todo el acceso entre servicios usa la
// identidad administrada del servidor: no hay contraseñas, claves ni cadenas de conexión.
targetScope = 'resourceGroup'

@allowed(['dev', 'prod'])
param env string
param location string = resourceGroup().location
@description('Object ID de la identidad que despliega (GitHub Actions); recibe permiso para escribir el secreto JWT.')
param deployerPrincipalId string
param prefix string = 'duelo'

var suffix = uniqueString(resourceGroup().id)
var tags = { app: 'duelo-magos', env: env }

// ───────────── observabilidad ─────────────
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${prefix}-${env}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: env == 'prod' ? 1 : json('0.3') }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${prefix}-${env}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
    // Solo se aceptan datos autenticados con Entra (identidad administrada).
    DisableLocalAuth: true
  }
}

// ───────────── identidad del servidor ─────────────
resource appId 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${prefix}-app-${env}'
  location: location
  tags: tags
}

// ───────────── registro de contenedores ─────────────
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'acr${prefix}${env}${suffix}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false, anonymousPullEnabled: false }
}

// ───────────── Key Vault (RBAC) ─────────────
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-${prefix}-${env}-${take(suffix, 8)}'
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Enabled'
  }
}

// ───────────── PostgreSQL (solo autenticación Entra) ─────────────
resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: 'psql-${prefix}-${env}-${take(suffix, 8)}'
  location: location
  tags: tags
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '16'
    storage: { storageSizeGB: 32, autoGrow: 'Disabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    authConfig: { activeDirectoryAuth: 'Enabled', passwordAuth: 'Disabled', tenantId: subscription().tenantId }
    network: { publicNetworkAccess: 'Enabled' }
  }
}

resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: 'duelo'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

// Solo servicios de Azure (Container Apps). TLS obligatorio por defecto.
resource pgFirewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: pg
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource pgExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: pg
  name: 'azure.extensions'
  properties: { value: 'CITEXT', source: 'user-override' }
  dependsOn: [pgDb, pgFirewall]
}

// La identidad del servidor es la administradora Entra de la base (crea el esquema en las migraciones).
resource pgAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = {
  parent: pg
  name: appId.properties.principalId
  properties: {
    principalType: 'ServicePrincipal'
    principalName: appId.name
    tenantId: subscription().tenantId
  }
  dependsOn: [pgExtensions]
}

// ───────────── Azure Managed Redis (solo autenticación Entra) ─────────────
resource redis 'Microsoft.Cache/redisEnterprise@2024-10-01' = {
  name: 'redis-${prefix}-${env}-${take(suffix, 8)}'
  location: location
  tags: tags
  sku: { name: 'Balanced_B0' }
  properties: { minimumTlsVersion: '1.2', highAvailability: 'Disabled' }
}

resource redisDb 'Microsoft.Cache/redisEnterprise/databases@2024-10-01' = {
  parent: redis
  name: 'default'
  properties: {
    clientProtocol: 'Encrypted'
    port: 10000
    clusteringPolicy: 'EnterpriseCluster'
    evictionPolicy: 'NoEviction'
    accessKeysAuthentication: 'Disabled'
  }
}

resource redisAccess 'Microsoft.Cache/redisEnterprise/databases/accessPolicyAssignments@2024-10-01' = {
  parent: redisDb
  name: 'appidentity'
  properties: {
    accessPolicyName: 'default'
    user: { objectId: appId.properties.principalId }
  }
}

// ───────────── roles (mínimo privilegio) ─────────────
var roles = {
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
  kvSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  kvSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
  monitoringMetricsPublisher: '3913510d-42f4-4e42-8a64-420c390055eb'
}

resource appAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, appId.id, roles.acrPull)
  scope: acr
  properties: {
    principalId: appId.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPull)
  }
}

resource appKvRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, appId.id, roles.kvSecretsUser)
  scope: kv
  properties: {
    principalId: appId.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.kvSecretsUser)
  }
}

resource deployerKvWrite 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, deployerPrincipalId, roles.kvSecretsOfficer)
  scope: kv
  properties: {
    principalId: deployerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.kvSecretsOfficer)
  }
}

resource appTelemetry 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(appInsights.id, appId.id, roles.monitoringMetricsPublisher)
  scope: appInsights
  properties: {
    principalId: appId.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.monitoringMetricsPublisher)
  }
}

// ───────────── entorno de Container Apps ─────────────
resource caEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${prefix}-${env}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
}

output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
output keyVaultName string = kv.name
output keyVaultUri string = kv.properties.vaultUri
output appIdentityId string = appId.id
output appIdentityClientId string = appId.properties.clientId
output appIdentityPrincipalId string = appId.properties.principalId
output appIdentityName string = appId.name
output pgHost string = pg.properties.fullyQualifiedDomainName
output redisHost string = redis.properties.hostName
output appInsightsConnectionString string = appInsights.properties.ConnectionString
output appInsightsId string = appInsights.id
output logAnalyticsId string = logs.id
output caEnvId string = caEnv.id
output caEnvDomain string = caEnv.properties.defaultDomain
