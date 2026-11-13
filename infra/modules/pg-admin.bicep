// Módulo aparte: el nombre del administrador es el object id de la identidad, que solo se conoce
// durante el despliegue (los parámetros de un módulo sí pueden ser valores de tiempo de ejecución).
param serverName string
param principalId string
param principalName string

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' existing = {
  name: serverName
}

resource admin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = {
  parent: pg
  name: principalId
  properties: {
    principalType: 'ServicePrincipal'
    principalName: principalName
    tenantId: subscription().tenantId
  }
}
