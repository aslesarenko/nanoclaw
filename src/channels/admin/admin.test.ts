import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';

import { createAdminHttpServer, AdminHttpServer } from './http.js';
import { registerAdminRoutes } from './admin.js';
import type { RegisteredGroup } from '../../types.js';

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

let nextPort = 19900;

describe('admin routes', () => {
  let server: AdminHttpServer;
  let PORT: number;
  let base: string;
  const groups: Record<string, RegisteredGroup> = {};
  const registerGroupMock = vi.fn((jid: string, group: RegisteredGroup) => {
    groups[jid] = group;
  });

  beforeEach(async () => {
    PORT = nextPort++;
    base = `http://localhost:${PORT}`;

    // Clear groups
    for (const key of Object.keys(groups)) delete groups[key];
    registerGroupMock.mockClear();

    server = createAdminHttpServer({ port: PORT });
    registerAdminRoutes(server, {
      registeredGroups: () => groups,
      registerGroup: registerGroupMock,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('GET /health returns ok', async () => {
    const res = await httpRequest('GET', `${base}/health`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.status).toBe('ok');
    expect(data.assistantName).toBeTruthy();
  });

  it('GET /groups returns registered groups', async () => {
    groups['admin:test'] = {
      name: 'Test',
      folder: 'test',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00Z',
    };
    const res = await httpRequest('GET', `${base}/groups`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data['admin:test'].name).toBe('Test');
  });

  it('POST /groups creates a group via registerGroup', async () => {
    const res = await httpRequest(
      'POST',
      `${base}/groups`,
      JSON.stringify({
        jid: 'admin:new',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      }),
    );
    expect(res.status).toBe(201);
    expect(registerGroupMock).toHaveBeenCalledOnce();
    expect(registerGroupMock).toHaveBeenCalledWith(
      'admin:new',
      expect.objectContaining({ name: 'New Group', folder: 'new-group', trigger: '@Andy' }),
    );
  });

  it('POST /groups defaults requiresTrigger=true and isMain=false', async () => {
    await httpRequest(
      'POST',
      `${base}/groups`,
      JSON.stringify({ jid: 'admin:x', name: 'X', folder: 'x', trigger: '@Andy' }),
    );
    const group = registerGroupMock.mock.calls[0][1];
    expect(group.requiresTrigger).toBe(true);
    expect(group.isMain).toBe(false);
  });

  it('POST /groups with invalid JSON returns 400', async () => {
    const res = await httpRequest('POST', `${base}/groups`, 'not json');
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Invalid JSON');
  });

  it('POST /groups with missing fields returns 400', async () => {
    const res = await httpRequest(
      'POST',
      `${base}/groups`,
      JSON.stringify({ jid: 'admin:x' }),
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain('Missing required fields');
  });
});
