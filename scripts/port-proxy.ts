#!/usr/bin/env tsx
/**
 * HTTP proxy: forwards http://localhost:4000 to the nanoclaw container's port 4000.
 *
 * Needed on macOS where Docker container IPs aren't routable from the host.
 * Uses `docker exec curl` to relay requests into the running container.
 *
 * Usage: npx tsx scripts/port-proxy.ts [port]
 */
import http from 'http';
import { execFile, execSync } from 'child_process';

const PORT = parseInt(process.argv[2] || '4000', 10);

function findContainer(): string {
  const out = execSync(
    `docker ps --format '{{.Names}}' --filter 'name=nanoclaw-'`,
    { encoding: 'utf8' },
  ).trim();
  const names = out.split('\n').filter(Boolean);
  if (names.length === 0) {
    console.error('No running nanoclaw container found.');
    process.exit(1);
  }
  if (names.length > 1) {
    console.error(`Multiple containers found: ${names.join(', ')}. Using ${names[0]}.`);
  }
  return names[0];
}

const container = findContainer();
console.log(`Container: ${container}`);

const server = http.createServer((req, res) => {
  const url = `http://localhost:${PORT}${req.url}`;
  const args = ['exec', container, 'curl', '-s', '-i', url];

  const bodyChunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
  req.on('end', () => {
    if (bodyChunks.length > 0) {
      args.push('-X', req.method!, '-d', Buffer.concat(bodyChunks).toString());
      if (req.headers['content-type']) {
        args.push('-H', `Content-Type: ${req.headers['content-type']}`);
      }
    }

    execFile('docker', args, { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 }, (err, stdout) => {
      if (err) {
        res.writeHead(502);
        res.end('Proxy error: ' + err.message);
        return;
      }

      const headerEnd = stdout.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(stdout);
        return;
      }

      const headerSection = stdout.slice(0, headerEnd);
      const body = stdout.slice(headerEnd + 4);
      const headerLines = headerSection.split('\r\n');

      const statusMatch = headerLines[0].match(/HTTP\/\S+\s+(\d+)/);
      const statusCode = statusMatch ? parseInt(statusMatch[1]) : 200;

      const headers: Record<string, string> = {};
      for (let i = 1; i < headerLines.length; i++) {
        const colonIdx = headerLines[i].indexOf(':');
        if (colonIdx > 0) {
          const key = headerLines[i].slice(0, colonIdx).trim().toLowerCase();
          const val = headerLines[i].slice(colonIdx + 1).trim();
          if (key !== 'transfer-encoding') {
            headers[key] = val;
          }
        }
      }

      res.writeHead(statusCode, headers);
      res.end(body);
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Proxy ready: http://localhost:${PORT} -> ${container}:${PORT}`);
});
