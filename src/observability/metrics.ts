import { metrics, type ObservableResult } from '@opentelemetry/api';

const meter = metrics.getMeter('duelo-magos', '1.0.0');

/** Métricas propias del juego. Se exportan a Application Insights mediante OpenTelemetry. */
export const gameMetrics = {
  wsConnections: meter.createUpDownCounter('game.ws.connections', {
    description: 'Conexiones WebSocket abiertas en esta réplica',
  }),
  actions: meter.createCounter('game.actions', { description: 'Jugadas procesadas (por resultado)' }),
  actionLatency: meter.createHistogram('game.action.latency', {
    description: 'Desde que llega la jugada hasta que se difunde el nuevo estado',
    unit: 'ms',
  }),
  roundsResolved: meter.createCounter('game.rounds.resolved', { description: 'Rondas resueltas' }),
  matchesFinished: meter.createCounter('game.matches.finished', { description: 'Partidas terminadas' }),
  rateLimited: meter.createCounter('game.rate_limited', { description: 'Solicitudes rechazadas por límite de tasa' }),
};

let activeMatches = 0;
export const setActiveMatches = (n: number): void => {
  activeMatches = n;
};

meter
  .createObservableGauge('game.matches.active', { description: 'Partidas activas (en curso) en todo el sistema' })
  .addCallback((r: ObservableResult) => r.observe(activeMatches));
