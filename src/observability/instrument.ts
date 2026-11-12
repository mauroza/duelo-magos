/**
 * Se carga con `node --import` antes que la aplicación para que la instrumentación
 * automática (HTTP, pg, Redis) envuelva los módulos. Envía trazas, métricas y logs a
 * Application Insights usando identidad administrada (sin claves).
 */
import { DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { useAzureMonitor } from '@azure/monitor-opentelemetry';

const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
if (connectionString) {
  const clientId = process.env.AZURE_CLIENT_ID;
  useAzureMonitor({
    azureMonitorExporterOptions: {
      connectionString,
      credential: clientId ? new ManagedIdentityCredential({ clientId }) : new DefaultAzureCredential(),
    },
    instrumentationOptions: { http: { enabled: true }, postgreSql: { enabled: true }, redis4: { enabled: true } },
    enableLiveMetrics: true,
  });
}
