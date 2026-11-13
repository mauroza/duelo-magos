// Container App del servidor + alertas. Se despliega después de core.bicep y de publicar la imagen.
targetScope = 'resourceGroup'

@allowed(['dev', 'prod'])
param env string
param location string = resourceGroup().location
param prefix string = 'duelo'
@description('Imagen completa, p. ej. acrxxx.azurecr.io/duelo-magos:<sha>')
param image string
param revisionSuffix string
param acrLoginServer string
param appIdentityId string
param appIdentityClientId string
param appIdentityName string
param keyVaultUri string
param pgHost string
@secure()
param appInsightsConnectionString string
param appInsightsId string
param logAnalyticsId string
param caEnvId string
param caEnvDomain string
@description('Correo opcional para las alertas.')
param alertEmail string = ''

var appName = 'ca-${prefix}-${env}'
var redisName = 'ca-redis-${env}'
// Secretos de Container Apps referenciados a Key Vault: se leen con la identidad administrada.
var redisSecret = { name: 'redis-password', keyVaultUrl: '${keyVaultUri}secrets/redis-password', identity: appIdentityId }

// Redis privado: solo accesible dentro del entorno (VNet), con contraseña de Key Vault.
// Guarda únicamente datos efímeros (pub/sub, tickets, límites, cola, presencia): el estado de las
// partidas vive en PostgreSQL, así que reiniciar Redis no pierde jugadas.
resource redis 'Microsoft.App/containerApps@2024-03-01' = {
  name: redisName
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${appIdentityId}': {} } }
  properties: {
    environmentId: caEnvId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: false, transport: 'tcp', targetPort: 6379, exposedPort: 6379 }
      secrets: [redisSecret]
    }
    template: {
      containers: [
        {
          name: 'redis'
          image: 'docker.io/library/redis:7.4-alpine'
          command: ['sh', '-c', 'exec redis-server --requirepass "$REDIS_PASSWORD" --save "" --appendonly no --maxmemory 400mb --maxmemory-policy noeviction']
          env: [{ name: 'REDIS_PASSWORD', secretRef: 'redis-password' }]
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          probes: [{ type: 'Liveness', tcpSocket: { port: 6379 }, periodSeconds: 10 }]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}
var fqdn = '${appName}.${caEnvDomain}'
var tags = { app: 'duelo-magos', env: env }

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  dependsOn: [redis]
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${appIdentityId}': {} } }
  properties: {
    environmentId: caEnvId
    workloadProfileName: 'Consumption'
    configuration: {
      // Varias revisiones activas: permite dividir tráfico y volver atrás (rollback) en segundos.
      activeRevisionsMode: 'Multiple'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
        traffic: [{ latestRevision: true, weight: 100 }]
      }
      registries: [{ server: acrLoginServer, identity: appIdentityId }]
      secrets: [redisSecret]
    }
    template: {
      revisionSuffix: revisionSuffix
      terminationGracePeriodSeconds: 30
      containers: [
        {
          name: 'server'
          image: image
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'AUTH_MODE', value: 'azure' }
            { name: 'AZURE_CLIENT_ID', value: appIdentityClientId }
            { name: 'KEY_VAULT_URI', value: keyVaultUri }
            { name: 'PGHOST', value: pgHost }
            { name: 'PGDATABASE', value: 'duelo' }
            { name: 'PGUSER', value: appIdentityName }
            { name: 'REDIS_HOST', value: redisName }
            { name: 'REDIS_PORT', value: '6379' }
            { name: 'REDIS_AUTH', value: 'password' }
            { name: 'REDIS_TLS', value: 'false' }
            { name: 'REDIS_PASSWORD', secretRef: 'redis-password' }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
            { name: 'ALLOWED_ORIGINS', value: 'https://${fqdn}' }
            { name: 'LOG_LEVEL', value: env == 'prod' ? 'info' : 'debug' }
            { name: 'SHUTDOWN_DRAIN_MS', value: '15000' }
          ]
          probes: [
            { type: 'Startup', httpGet: { path: '/health/live', port: 8080 }, periodSeconds: 3, failureThreshold: 20 }
            { type: 'Liveness', httpGet: { path: '/health/live', port: 8080 }, periodSeconds: 10, failureThreshold: 3 }
            { type: 'Readiness', httpGet: { path: '/health/ready', port: 8080 }, periodSeconds: 5, failureThreshold: 2 }
          ]
        }
      ]
      scale: {
        // dev escala a cero cuando no se usa (costo); prod mantiene una réplica para los temporizadores.
        minReplicas: env == 'prod' ? 1 : 0
        maxReplicas: env == 'prod' ? 3 : 1
        rules: [{ name: 'http', http: { metadata: { concurrentRequests: '200' } } }]
      }
    }
  }
}

// ───────────── alertas ─────────────
resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'ag-${prefix}-${env}'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: 'duelo${env}'
    enabled: true
    emailReceivers: empty(alertEmail) ? [] : [{ name: 'owner', emailAddress: alertEmail, useCommonAlertSchema: true }]
  }
}

resource latencyAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-${prefix}-${env}-latencia'
  location: location
  tags: tags
  properties: {
    displayName: 'Latencia por jugada alta (> 200 ms promedio en 5 min)'
    severity: 2
    enabled: true
    skipQueryValidation: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    scopes: [appInsightsId]
    criteria: {
      allOf: [
        {
          query: 'customMetrics | where name == "game.action.latency" | summarize avgMs = sum(valueSum) / sum(valueCount)'
          timeAggregation: 'Maximum'
          metricMeasureColumn: 'avgMs'
          operator: 'GreaterThan'
          threshold: 200
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [actionGroup.id] }
  }
}

resource errorAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-${prefix}-${env}-errores'
  location: location
  tags: tags
  properties: {
    displayName: 'Tasa de error HTTP 5xx > 1 % en 5 min'
    severity: 1
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    scopes: [appInsightsId]
    criteria: {
      allOf: [
        {
          query: 'requests | summarize total = count(), failed = countif(toint(resultCode) >= 500) | where total > 20 | extend rate = 100.0 * failed / total'
          timeAggregation: 'Maximum'
          metricMeasureColumn: 'rate'
          operator: 'GreaterThan'
          threshold: 1
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [actionGroup.id] }
  }
}

resource restartAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-${prefix}-${env}-reinicios'
  location: location
  tags: tags
  properties: {
    displayName: 'Réplica reiniciándose repetidamente'
    severity: 2
    enabled: true
    // La tabla de logs del sistema aparece cuando el entorno emite su primer log.
    skipQueryValidation: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    scopes: [logAnalyticsId]
    criteria: {
      allOf: [
        {
          query: 'ContainerAppSystemLogs_CL | where ContainerAppName_s == "${appName}" and Reason_s in ("BackOff", "ContainerTerminated") | summarize n = count()'
          timeAggregation: 'Maximum'
          metricMeasureColumn: 'n'
          operator: 'GreaterThan'
          threshold: 3
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [actionGroup.id] }
  }
}

output url string = 'https://${fqdn}'
output latestRevision string = app.properties.latestRevisionName
