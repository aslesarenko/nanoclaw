import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import http from 'http';

import { createAdminHttpServer, AdminHttpServer, jsonResponse } from './http.js';

function httpRequest(
  method: string,
  url: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: body
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let nextPort = 19870;

describe('AdminHttpServer', () => {
  let server: AdminHttpServer;
  let PORT: number;

  beforeEach(() => {
    PORT = nextPort++;
  });

  afterEach(async () => {
    if (server?.isListening()) await server.stop();
  });

  it('createAdminHttpServer returns an AdminHttpServer', () => {
    server = createAdminHttpServer({ port: PORT });
    expect(server).toBeInstanceOf(AdminHttpServer);
  });

  it('starts and reports isListening', async () => {
    server = createAdminHttpServer({ port: PORT });
    expect(server.isListening()).toBe(false);
    await server.start();
    expect(server.isListening()).toBe(true);
  });

  it('stops and reports not listening', async () => {
    server = createAdminHttpServer({ port: PORT });
    await server.start();
    await server.stop();
    expect(server.isListening()).toBe(false);
  });

  it('stop on non-listening server is a no-op', async () => {
    server = createAdminHttpServer({ port: PORT });
    await server.stop(); // should not throw
  });

  it('returns 404 for unknown routes', async () => {
    server = createAdminHttpServer({ port: PORT });
    await server.start();
    const res = await httpRequest('GET', `http://localhost:${PORT}/nonexistent`);
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Not found', path: '/nonexistent' });
  });

  it('routes GET requests to registered handler', async () => {
    server = createAdminHttpServer({ port: PORT });
    server.addRoute('GET', '/ping', (_req, res) => {
      jsonResponse(res, 200, { pong: true });
    });
    await server.start();

    const res = await httpRequest('GET', `http://localhost:${PORT}/ping`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ pong: true });
  });

  it('routes POST requests and passes body', async () => {
    server = createAdminHttpServer({ port: PORT });
    server.addRoute('POST', '/echo', (_req, res, body) => {
      jsonResponse(res, 200, { echo: JSON.parse(body) });
    });
    await server.start();

    const res = await httpRequest('POST', `http://localhost:${PORT}/echo`, JSON.stringify({ hello: 'world' }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ echo: { hello: 'world' } });
  });

  it('removeRoute makes route return 404', async () => {
    server = createAdminHttpServer({ port: PORT });
    server.addRoute('GET', '/temp', (_req, res) => {
      jsonResponse(res, 200, { ok: true });
    });
    await server.start();

    // Route exists
    let res = await httpRequest('GET', `http://localhost:${PORT}/temp`);
    expect(res.status).toBe(200);

    // Remove and verify 404
    server.removeRoute('GET', '/temp');
    res = await httpRequest('GET', `http://localhost:${PORT}/temp`);
    expect(res.status).toBe(404);
  });

  it('method is case-insensitive for addRoute/removeRoute', async () => {
    server = createAdminHttpServer({ port: PORT });
    server.addRoute('get', '/case-test', (_req, res) => {
      jsonResponse(res, 200, { ok: true });
    });
    await server.start();

    const res = await httpRequest('GET', `http://localhost:${PORT}/case-test`);
    expect(res.status).toBe(200);

    server.removeRoute('GET', '/case-test');
    const res2 = await httpRequest('GET', `http://localhost:${PORT}/case-test`);
    expect(res2.status).toBe(404);
  });
});
