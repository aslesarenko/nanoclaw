import { randomUUID } from 'crypto';
import { URL } from 'url';

import type { Channel, NewMessage } from '../../types.js';
import type { ChannelOpts } from '../registry.js';
import { registerChannel } from '../registry.js';
import { registerGroup } from '../../index.js';
import { ADMIN_CHANNEL_PORT } from '../../config.js';
import { createAdminHttpServer, jsonResponse } from './http.js';
import type { AdminHttpServer } from './http.js';
import { registerAdminRoutes } from './admin.js';

interface CapturedResponse {
  jid: string;
  text: string;
  timestamp: string;
}

export class AdminChannel implements Channel {
  name = 'admin';
  private server: AdminHttpServer;
  private opts: ChannelOpts;
  private connected = false;
  private responses: CapturedResponse[] = [];
  private awaiters: Array<{
    jid: string;
    since: string;
    count: number;
    resolve: (responses: CapturedResponse[]) => void;
  }> = [];

  constructor(server: AdminHttpServer, opts: ChannelOpts) {
    this.server = server;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Register message routes on the server
    this.server.addRoute('POST', '/messages', (_req, res, body) => {
      this.handlePostMessage(res, body);
    });
    this.server.addRoute('GET', '/responses', (req, res) => {
      this.handleGetResponses(req, res);
    });
    this.connected = true;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const entry: CapturedResponse = {
      jid,
      text,
      timestamp: new Date().toISOString(),
    };
    this.responses.push(entry);

    // Check if any awaiters are satisfied
    for (let i = this.awaiters.length - 1; i >= 0; i--) {
      const aw = this.awaiters[i];
      const matching = this.responses.filter(
        (r) => r.jid === aw.jid && r.timestamp >= aw.since,
      );
      if (matching.length >= aw.count) {
        aw.resolve(matching);
        this.awaiters.splice(i, 1);
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('admin:');
  }

  async disconnect(): Promise<void> {
    this.server.removeRoute('POST', '/messages');
    this.server.removeRoute('GET', '/responses');
    this.connected = false;
  }

  private handlePostMessage(res: import('http').ServerResponse, body: string): void {
    let data: { jid: string; content: string; sender?: string; sender_name?: string };
    try {
      data = JSON.parse(body);
    } catch {
      jsonResponse(res, 400, { error: 'Invalid JSON' });
      return;
    }

    if (!data.jid || !data.content) {
      jsonResponse(res, 400, { error: 'Missing required fields: jid, content' });
      return;
    }

    const chatJid = data.jid.startsWith('admin:') ? data.jid : `admin:${data.jid}`;
    const id = randomUUID();
    const timestamp = new Date().toISOString();

    const message: NewMessage = {
      id,
      chat_jid: chatJid,
      sender: data.sender || 'admin:user',
      sender_name: data.sender_name || 'Test User',
      content: data.content,
      timestamp,
    };

    // Notify chat metadata so the message loop knows about this JID
    this.opts.onChatMetadata(chatJid, timestamp, chatJid, 'admin', true);

    // Deliver the message
    this.opts.onMessage(chatJid, message);

    jsonResponse(res, 201, { id, timestamp });
  }

  private handleGetResponses(req: import('http').IncomingMessage, res: import('http').ServerResponse): void {
    const url = new URL(req.url || '/', `http://localhost`);
    const jid = url.searchParams.get('jid') || '';
    const since = url.searchParams.get('since') || '1970-01-01T00:00:00Z';
    const awaitCount = parseInt(url.searchParams.get('awaitCount') || '0', 10);
    const timeout = parseInt(url.searchParams.get('timeout') || '60000', 10);

    const matching = this.responses.filter(
      (r) => r.jid === jid && r.timestamp >= since,
    );

    // If not awaiting or already have enough, return immediately
    if (awaitCount <= 0 || matching.length >= awaitCount) {
      jsonResponse(res, 200, { responses: matching });
      return;
    }

    // Hold the request open until awaitCount responses arrive or timeout
    const timer = setTimeout(() => {
      // Remove from awaiters and return whatever we have
      const idx = this.awaiters.findIndex((a) => a.resolve === resolve);
      if (idx >= 0) this.awaiters.splice(idx, 1);
      const current = this.responses.filter(
        (r) => r.jid === jid && r.timestamp >= since,
      );
      jsonResponse(res, 200, { responses: current, timedOut: true });
    }, timeout);

    const resolve = (responses: CapturedResponse[]) => {
      clearTimeout(timer);
      jsonResponse(res, 200, { responses });
    };

    this.awaiters.push({ jid, since, count: awaitCount, resolve });
  }
}

// Self-registration: always active (default port 9877, override via ADMIN_CHANNEL_PORT)
registerChannel('admin', (opts: ChannelOpts) => {
  const port = ADMIN_CHANNEL_PORT;

  // Create and start the HTTP server independently
  const server = createAdminHttpServer({ port });

  // Register admin routes (health, groups) — always available while server runs
  registerAdminRoutes(server, {
    registeredGroups: opts.registeredGroups,
    registerGroup,
  });

  // Start the server (async, but channel.connect() will be called after)
  server.start().catch((err) => {
    console.error('Failed to start admin HTTP server:', err);
  });

  return new AdminChannel(server, opts);
});
