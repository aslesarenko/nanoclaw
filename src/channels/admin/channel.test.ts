import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';

import { createAdminHttpServer, AdminHttpServer } from './http.js';
import { AdminChannel } from './index.js';
import type { ChannelOpts } from '../registry.js';

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

let nextPort = 19930;

describe('AdminChannel', () => {
  let server: AdminHttpServer;
  let channel: AdminChannel;
  let PORT: number;
  let base: string;

  const onMessage = vi.fn();
  const onChatMetadata = vi.fn();
  const opts: ChannelOpts = {
    onMessage,
    onChatMetadata,
    registeredGroups: () => ({}),
  };

  beforeEach(async () => {
    PORT = nextPort++;
    base = `http://localhost:${PORT}`;
    onMessage.mockClear();
    onChatMetadata.mockClear();
    server = createAdminHttpServer({ port: PORT });
    await server.start();
    channel = new AdminChannel(server, opts);
  });

  afterEach(async () => {
    if (channel.isConnected()) await channel.disconnect();
    await server.stop();
  });

  it('ownsJid returns true for admin: prefix', () => {
    expect(channel.ownsJid('admin:foo')).toBe(true);
    expect(channel.ownsJid('telegram:foo')).toBe(false);
  });

  it('isConnected is false before connect', () => {
    expect(channel.isConnected()).toBe(false);
  });

  it('connect registers routes, disconnect removes them', async () => {
    await channel.connect();
    expect(channel.isConnected()).toBe(true);

    // /messages should be available
    const res = await httpRequest(
      'POST',
      `${base}/messages`,
      JSON.stringify({ jid: 'admin:test', content: 'hi' }),
    );
    expect(res.status).toBe(201);

    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);

    // /messages should be gone
    const res2 = await httpRequest(
      'POST',
      `${base}/messages`,
      JSON.stringify({ jid: 'admin:test', content: 'hi' }),
    );
    expect(res2.status).toBe(404);
  });

  it('POST /messages calls onMessage and onChatMetadata', async () => {
    await channel.connect();
    const res = await httpRequest(
      'POST',
      `${base}/messages`,
      JSON.stringify({ jid: 'admin:grp', content: 'hello', sender: 'admin:u1' }),
    );
    expect(res.status).toBe(201);
    const data = JSON.parse(res.body);
    expect(data.id).toBeTruthy();
    expect(data.timestamp).toBeTruthy();

    expect(onChatMetadata).toHaveBeenCalledWith('admin:grp', expect.any(String), 'admin:grp', 'admin', true);
    expect(onMessage).toHaveBeenCalledWith(
      'admin:grp',
      expect.objectContaining({
        chat_jid: 'admin:grp',
        content: 'hello',
        sender: 'admin:u1',
      }),
    );
  });

  it('POST /messages auto-prefixes jid with admin:', async () => {
    await channel.connect();
    await httpRequest(
      'POST',
      `${base}/messages`,
      JSON.stringify({ jid: 'test', content: 'hello' }),
    );
    expect(onMessage).toHaveBeenCalledWith(
      'admin:test',
      expect.objectContaining({ chat_jid: 'admin:test' }),
    );
  });

  it('POST /messages returns 400 for invalid JSON', async () => {
    await channel.connect();
    const res = await httpRequest('POST', `${base}/messages`, 'not json');
    expect(res.status).toBe(400);
  });

  it('POST /messages returns 400 for missing fields', async () => {
    await channel.connect();
    const res = await httpRequest(
      'POST',
      `${base}/messages`,
      JSON.stringify({ jid: 'admin:x' }),
    );
    expect(res.status).toBe(400);
  });

  it('GET /responses returns empty when no responses captured', async () => {
    await channel.connect();
    const res = await httpRequest('GET', `${base}/responses?jid=admin:grp&since=1970-01-01T00:00:00Z`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).responses).toHaveLength(0);
  });

  it('sendMessage captures responses queryable via GET /responses', async () => {
    await channel.connect();
    const since = new Date().toISOString();
    await channel.sendMessage('admin:grp', 'bot reply');

    const res = await httpRequest('GET', `${base}/responses?jid=admin:grp&since=${since}`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.responses).toHaveLength(1);
    expect(data.responses[0].text).toBe('bot reply');
  });

  it('GET /responses filters by jid', async () => {
    await channel.connect();
    const since = new Date().toISOString();
    await channel.sendMessage('admin:grp1', 'reply1');
    await channel.sendMessage('admin:grp2', 'reply2');

    const res = await httpRequest('GET', `${base}/responses?jid=admin:grp1&since=${since}`);
    const data = JSON.parse(res.body);
    expect(data.responses).toHaveLength(1);
    expect(data.responses[0].text).toBe('reply1');
  });

  it('GET /responses with awaitCount waits for responses', async () => {
    await channel.connect();
    const since = new Date().toISOString();

    // Start waiting for 1 response with short timeout
    const responsePromise = httpRequest(
      'GET',
      `${base}/responses?jid=admin:grp&since=${since}&awaitCount=1&timeout=5000`,
    );

    // Deliver response after small delay
    await new Promise((r) => setTimeout(r, 50));
    await channel.sendMessage('admin:grp', 'delayed reply');

    const res = await responsePromise;
    const data = JSON.parse(res.body);
    expect(data.responses).toHaveLength(1);
    expect(data.responses[0].text).toBe('delayed reply');
    expect(data.timedOut).toBeUndefined();
  });

  it('GET /responses with awaitCount times out gracefully', async () => {
    await channel.connect();
    const since = new Date().toISOString();

    const res = await httpRequest(
      'GET',
      `${base}/responses?jid=admin:grp&since=${since}&awaitCount=1&timeout=100`,
    );
    const data = JSON.parse(res.body);
    expect(data.responses).toHaveLength(0);
    expect(data.timedOut).toBe(true);
  });
});
