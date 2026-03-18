import { fork, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';

import { startMockServer, stopMockServer, type MockFixture } from './mock-server.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');

export interface HarnessOptions {
  adminPort?: number;     // default: 9877
  mockApiPort?: number;   // default: 9876 (0 = skip mock, use real API)
  mockFixtures?: MockFixture[];
}

interface ResponseEntry {
  jid: string;
  text: string;
  timestamp: string;
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function httpPost(url: string, body: object): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class IntegrationHarness {
  private adminPort: number;
  private mockApiPort: number;
  private mockFixtures?: MockFixture[];
  private hostProc: ChildProcess | null = null;
  private mockServer: http.Server | null = null;
  private envBackup: string | null = null;
  private envPath: string;
  private baseUrl: string;
  private externalHost = false; // true when reusing an already-running host

  constructor(opts?: HarnessOptions) {
    this.adminPort = opts?.adminPort ?? 9877;
    this.mockApiPort = opts?.mockApiPort ?? 9876;
    this.mockFixtures = opts?.mockFixtures;
    this.envPath = path.join(PROJECT_ROOT, '.env');
    this.baseUrl = `http://localhost:${this.adminPort}`;
  }

  /** Check if a host is already listening on the admin port. */
  private async isHostRunning(): Promise<boolean> {
    try {
      const body = await httpGet(`${this.baseUrl}/health`);
      const data = JSON.parse(body);
      return data.status === 'ok';
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    // 1. Check if host is already running — reuse it
    console.log('[harness] Checking if host is already running on port', this.adminPort);
    if (await this.isHostRunning()) {
      this.externalHost = true;
      console.log('[harness] External host detected — reusing existing instance');
      return;
    }
    console.log('[harness] No running host found — will start a new instance');

    // 2. Backup existing .env
    console.log('[harness] Backing up .env');
    try {
      this.envBackup = fs.readFileSync(this.envPath, 'utf8');
      console.log('[harness] Existing .env backed up');
    } catch {
      this.envBackup = null;
      console.log('[harness] No existing .env to back up');
    }

    // 3. Start mock API server (unless mockApiPort=0 for CI_SMOKE)
    if (this.mockApiPort > 0) {
      console.log('[harness] Starting mock API server on port', this.mockApiPort);
      this.mockServer = await startMockServer(this.mockApiPort, this.mockFixtures);
      console.log('[harness] Mock API server started');
    } else {
      console.log('[harness] Skipping mock API server (mockApiPort=0, using real API)');
    }

    // 4. Write test .env
    console.log('[harness] Writing test .env');
    const envLines: string[] = [];
    if (this.mockApiPort > 0) {
      envLines.push(`ANTHROPIC_BASE_URL=http://localhost:${this.mockApiPort}`);
      envLines.push('ANTHROPIC_API_KEY=test-mock-key');
    }
    // Preserve existing .env lines that we don't override
    if (this.envBackup) {
      const overrideKeys = new Set(envLines.map((l) => l.split('=')[0]));
      for (const line of this.envBackup.split('\n')) {
        const key = line.split('=')[0]?.trim();
        if (key && !overrideKeys.has(key)) {
          envLines.push(line);
        }
      }
    }
    fs.writeFileSync(this.envPath, envLines.join('\n') + '\n');
    console.log('[harness] Test .env written');

    // 5. Spawn host subprocess
    const distEntry = path.join(PROJECT_ROOT, 'dist', 'index.js');
    console.log('[harness] Spawning host subprocess:', distEntry);
    this.hostProc = fork(distEntry, [], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        ADMIN_CHANNEL_PORT: String(this.adminPort),
        // Disable other channels so only admin channel is active
        NODE_ENV: 'test',
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    console.log('[harness] Host subprocess spawned (pid:', this.hostProc.pid, ')');

    // Forward stdout/stderr for debugging
    this.hostProc.stdout?.on('data', (d: Buffer) => {
      process.stdout.write(`[host] ${d.toString()}`);
    });
    this.hostProc.stderr?.on('data', (d: Buffer) => {
      process.stderr.write(`[host] ${d.toString()}`);
    });

    // 6. Wait for health check
    console.log('[harness] Waiting for host health check (timeout: 30s)');
    await this.waitForHealth(30000);
    console.log('[harness] Host is healthy and ready');
  }

  private async waitForHealth(timeoutMs: number): Promise<void> {
    const start = Date.now();
    let attempts = 0;
    while (Date.now() - start < timeoutMs) {
      attempts++;
      try {
        const body = await httpGet(`${this.baseUrl}/health`);
        const data = JSON.parse(body);
        if (data.status === 'ok') {
          console.log(`[harness] Health check passed after ${attempts} attempt(s) (${Date.now() - start}ms)`);
          return;
        }
      } catch {
        // not ready yet
      }
      if (attempts % 10 === 0) {
        console.log(`[harness] Still waiting for health... (${attempts} attempts, ${Date.now() - start}ms)`);
      }
      await sleep(500);
    }
    throw new Error(`Host did not become healthy within ${timeoutMs}ms (${attempts} attempts)`);
  }

  /** Fetch the assistant name from the host's /health or config endpoint. Falls back to 'Andy'. */
  async getAssistantName(): Promise<string> {
    try {
      const body = await httpGet(`${this.baseUrl}/health`);
      const data = JSON.parse(body);
      if (data.assistantName) return data.assistantName;
    } catch {
      // ignore
    }
    // Fallback: read ASSISTANT_NAME from .env
    try {
      const env = fs.readFileSync(this.envPath, 'utf8');
      const match = env.match(/^ASSISTANT_NAME=(.+)$/m);
      if (match) return match[1].trim();
    } catch {
      // ignore
    }
    return 'Andy';
  }

  async registerGroup(
    jid: string,
    opts: { name: string; folder: string; trigger: string; requiresTrigger?: boolean },
  ): Promise<void> {
    const fullJid = jid.startsWith('admin:') ? jid : `admin:${jid}`;
    console.log(`[harness] Registering group: ${fullJid} (folder: ${opts.folder}, trigger: ${opts.trigger})`);
    const res = await httpPost(`${this.baseUrl}/groups`, {
      jid: fullJid,
      ...opts,
    });
    if (res.status !== 201) {
      throw new Error(`Failed to register group: ${res.status} ${res.body}`);
    }
    console.log(`[harness] Group registered: ${fullJid}`);
  }

  async injectMessage(
    chatJid: string,
    content: string,
    sender?: string,
  ): Promise<{ id: string; timestamp: string }> {
    console.log(`[harness] Injecting message to ${chatJid}: "${content}" (sender: ${sender || 'admin:test-user'})`);
    const res = await httpPost(`${this.baseUrl}/messages`, {
      jid: chatJid,
      content,
      sender: sender || 'admin:test-user',
    });
    if (res.status !== 201) {
      throw new Error(`Failed to inject message: ${res.status} ${res.body}`);
    }
    const result = JSON.parse(res.body);
    console.log(`[harness] Message injected: id=${result.id}, timestamp=${result.timestamp}`);
    return result;
  }

  async waitForResponse(
    chatJid: string,
    since: string,
    opts?: { awaitCount?: number; timeoutMs?: number },
  ): Promise<string[]> {
    const awaitCount = opts?.awaitCount ?? 0;
    const timeout = opts?.timeoutMs ?? 60000;

    console.log(`[harness] Waiting for responses from ${chatJid} since ${since} (awaitCount: ${awaitCount}, timeout: ${timeout}ms)`);
    const url = new URL(`${this.baseUrl}/responses`);
    url.searchParams.set('jid', chatJid);
    url.searchParams.set('since', since);
    if (awaitCount > 0) {
      url.searchParams.set('awaitCount', String(awaitCount));
      url.searchParams.set('timeout', String(timeout));
    }

    const body = await httpGet(url.toString());
    const data = JSON.parse(body) as { responses: ResponseEntry[]; timedOut?: boolean };
    const texts = data.responses.map((r) => r.text);
    console.log(`[harness] Got ${texts.length} response(s)${data.timedOut ? ' (timed out)' : ''}${texts.length > 0 ? ': ' + JSON.stringify(texts.map(t => t.substring(0, 100))) : ''}`);
    return texts;
  }

  async stop(): Promise<void> {
    // When reusing an external host, don't touch it
    if (this.externalHost) {
      console.log('[harness] Using external host — skipping teardown');
      return;
    }

    console.log('[harness] Stopping harness...');

    // Kill host subprocess
    if (this.hostProc) {
      console.log('[harness] Sending SIGTERM to host subprocess (pid:', this.hostProc.pid, ')');
      this.hostProc.kill('SIGTERM');
      // Wait a bit for graceful shutdown
      await sleep(1000);
      if (!this.hostProc.killed) {
        console.log('[harness] Host did not exit, sending SIGKILL');
        this.hostProc.kill('SIGKILL');
      }
      this.hostProc = null;
      console.log('[harness] Host subprocess stopped');
    }

    // Stop mock server
    if (this.mockServer) {
      console.log('[harness] Stopping mock API server');
      await stopMockServer(this.mockServer);
      this.mockServer = null;
      console.log('[harness] Mock API server stopped');
    }

    // Restore .env
    if (this.envBackup !== null) {
      console.log('[harness] Restoring original .env');
      fs.writeFileSync(this.envPath, this.envBackup);
    } else {
      console.log('[harness] Removing test .env');
      try {
        fs.unlinkSync(this.envPath);
      } catch {
        // didn't exist before, ignore
      }
    }
    console.log('[harness] Teardown complete');
  }
}
