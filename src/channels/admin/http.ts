import http from 'http';

export interface RouteHandler {
  (req: http.IncomingMessage, res: http.ServerResponse, body: string): void;
}

export interface HttpServerOpts {
  port: number;
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export class AdminHttpServer {
  private server: http.Server;
  private routes = new Map<string, RouteHandler>(); // "METHOD /path" → handler
  private port: number;
  private listening = false;

  constructor(opts: HttpServerOpts) {
    this.port = opts.port;
    this.server = http.createServer(async (req, res) => {
      const method = (req.method || 'GET').toUpperCase();
      const url = new URL(req.url || '/', `http://localhost:${this.port}`);
      const key = `${method} ${url.pathname}`;

      const handler = this.routes.get(key);
      if (!handler) {
        jsonResponse(res, 404, { error: 'Not found', path: url.pathname });
        return;
      }

      try {
        const body = method === 'GET' || method === 'HEAD' ? '' : await readBody(req);
        handler(req, res, body);
      } catch (err) {
        jsonResponse(res, 500, {
          error: 'Internal server error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  addRoute(method: string, path: string, handler: RouteHandler): void {
    this.routes.set(`${method.toUpperCase()} ${path}`, handler);
  }

  removeRoute(method: string, path: string): void {
    this.routes.delete(`${method.toUpperCase()} ${path}`);
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, () => {
        this.listening = true;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.listening) return;
    return new Promise((resolve) => {
      this.server.close(() => {
        this.listening = false;
        resolve();
      });
    });
  }

  isListening(): boolean {
    return this.listening;
  }
}

export function createAdminHttpServer(opts: HttpServerOpts): AdminHttpServer {
  return new AdminHttpServer(opts);
}

export { jsonResponse };
