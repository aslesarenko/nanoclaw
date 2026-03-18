import http from 'http';

export interface MockFixture {
  match?: { userMessage: string };
  response: { content: string };
}

/**
 * Minimal Anthropic Messages API mock server.
 * Handles POST /v1/messages and returns a non-streaming response
 * in Anthropic Messages API format.
 *
 * We start with a hand-rolled ~50-line server instead of llmock
 * to avoid external dependency issues with the Claude Agent SDK's
 * exact request format. Can swap to llmock later if needed.
 */
export async function startMockServer(
  port: number,
  fixtures?: MockFixture[],
): Promise<http.Server> {
  const effectiveFixtures = fixtures || [
    { response: { content: 'Mock response from test server' } },
  ];

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/v1/messages')) {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        let requestBody: { messages?: Array<{ role: string; content: string }> } = {};
        try {
          requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // ignore parse errors, use default fixture
        }

        // Find matching fixture
        const userMsg = requestBody.messages
          ?.filter((m) => m.role === 'user')
          .pop()?.content || '';

        const fixture = effectiveFixtures.find((f) => {
          if (!f.match?.userMessage) return true; // no match = catch-all
          return userMsg.includes(f.match.userMessage);
        }) || effectiveFixtures[0];

        const responseText = fixture.response.content;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `msg_mock_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: responseText }],
            model: 'claude-sonnet-4-6',
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 20 },
          }),
        );
      });
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}

export async function stopMockServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
