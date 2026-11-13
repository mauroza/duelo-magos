import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { APP_ERROR_CODES } from '../../src/app/errors.js';
import { CLIENT_MESSAGE_TYPES, ClientMessage, SERVER_MESSAGE_TYPES } from '../../src/transport/ws/protocol.js';

interface AsyncApi {
  asyncapi: string;
  components: { messages: Record<string, { name: string; examples?: { payload: unknown }[] }> };
}
interface OpenApi {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: { ErrorCode: { enum: string[] } } };
}

const asyncapi = parse(readFileSync('contracts/asyncapi.yaml', 'utf8')) as AsyncApi;
const openapi = parse(readFileSync('contracts/openapi.yaml', 'utf8')) as OpenApi;
const serverSource = readFileSync('src/transport/http/server.ts', 'utf8');

describe('AsyncAPI sincronizado con el código', () => {
  const documented = Object.values(asyncapi.components.messages).map((m) => m.name);

  it('es AsyncAPI 3.0', () => expect(asyncapi.asyncapi).toBe('3.0.0'));

  it('documenta exactamente los mensajes que el código envía y recibe', () => {
    expect([...documented].sort()).toEqual([...CLIENT_MESSAGE_TYPES, ...SERVER_MESSAGE_TYPES].sort());
  });

  it('los ejemplos de mensajes del cliente pasan la validación real del servidor', () => {
    for (const m of Object.values(asyncapi.components.messages)) {
      if (!(CLIENT_MESSAGE_TYPES as readonly string[]).includes(m.name)) continue;
      expect(m.examples?.length, m.name).toBeGreaterThan(0);
      for (const ex of m.examples ?? []) {
        const r = ClientMessage.safeParse(ex.payload);
        expect(r.success, `${m.name}: ${JSON.stringify(r.error?.issues)}`).toBe(true);
      }
    }
  });
});

describe('OpenAPI sincronizado con el código', () => {
  it('es OpenAPI 3.1', () => expect(openapi.openapi).toBe('3.1.0'));

  it('cada ruta registrada está documentada y viceversa', () => {
    const routes = [...serverSource.matchAll(/app\.(get|post|patch|delete)\('([^']+)'/g)]
      .map(([, method, path]) => `${method!.toUpperCase()} ${path!.replace(/:(\w+)/g, '{$1}')}`)
      .filter((r) => !/ (\/|\/docs.*|\/contracts.*|\/play.*)$/.test(r));
    const documented = Object.entries(openapi.paths).flatMap(([path, ops]) =>
      Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`),
    );
    expect([...routes].sort()).toEqual([...documented].sort());
  });

  it('los códigos de error documentados son exactamente los del código', () => {
    expect([...openapi.components.schemas.ErrorCode.enum].sort()).toEqual([...APP_ERROR_CODES].sort());
  });
});
