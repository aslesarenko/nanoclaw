import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { IntegrationHarness } from './harness.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Smoke tests: run with real Anthropic API against the external (production) host.
// Skipped unless CI_SMOKE=true is set.
const describeSmoke =
  process.env.CI_SMOKE === 'true' ? describe : describe.skip;

describeSmoke('smoke: real API', () => {
  let harness: IntegrationHarness;
  let triggerName: string;

  beforeAll(async () => {
    console.log('[smoke] === Setting up smoke test suite ===');
    harness = new IntegrationHarness({
      adminPort: 9877,  // reuse external host (real API)
      mockApiPort: 0,   // 0 = no mock, reuse external host with real API
    });

    console.log('[smoke] Starting harness (real API)...');
    await harness.start();
    console.log('[smoke] Harness started');

    triggerName = harness.getAssistantName();
    console.log(`[smoke] Host assistant name: "${triggerName}"`);

    console.log('[smoke] Registering smoke group...');
    await harness.registerGroup('admin:smoke-group', {
      name: 'Smoke Group',
      folder: 'test-smoke',
      trigger: `@${triggerName}`,
      requiresTrigger: true,
    });
    console.log('[smoke] Smoke group registered');
    console.log('[smoke] === Setup complete ===');
  }, 60000);

  afterAll(async () => {
    console.log('[smoke] === Tearing down smoke test suite ===');
    await harness.stop();
    console.log('[smoke] === Teardown complete ===');
  }, 15000);

  it('ignores messages without trigger', async () => {
    console.log('[smoke] --- Test: ignores messages without trigger ---');
    const since = new Date().toISOString();

    console.log('[smoke] Injecting message without trigger: "hello world"');
    await harness.injectMessage('admin:smoke-group', 'hello world', 'admin:user123');

    console.log('[smoke] Sleeping 5s to let message loop process...');
    await sleep(5000);

    console.log('[smoke] Checking for responses (expecting none)...');
    const responses = await harness.waitForResponse('admin:smoke-group', since);
    console.log(`[smoke] Got ${responses.length} response(s) — expected 0`);
    expect(responses).toHaveLength(0);
    console.log('[smoke] --- Test passed ---');
  }, 15000);

  it('gets real Claude response', async () => {
    console.log('[smoke] --- Test: real Claude response ---');
    const since = new Date().toISOString();
    console.log(`[smoke] Since timestamp: ${since}`);

    const triggerMsg = `@${triggerName} say hello`;
    console.log(`[smoke] Injecting message: "${triggerMsg}"`);
    await harness.injectMessage(
      'admin:smoke-group',
      triggerMsg,
      'admin:user123',
    );

    console.log('[smoke] Waiting for response (awaitCount=1, timeout=90s)...');
    const responses = await harness.waitForResponse(
      'admin:smoke-group',
      since,
      { awaitCount: 1, timeoutMs: 90000 },
    );

    console.log(`[smoke] Got ${responses.length} response(s)`);
    if (responses.length > 0) {
      console.log(`[smoke] First response (truncated): "${responses[0].substring(0, 200)}"`);
    }
    expect(responses.length).toBeGreaterThan(0);
    console.log('[smoke] --- Test passed ---');
  }, 120000);

  it('responds to a follow-up question', async () => {
    console.log('[smoke] --- Test: follow-up question ---');
    const since = new Date().toISOString();

    const triggerMsg = `@${triggerName} reply with ONLY the number: what is 2+2?`;
    console.log(`[smoke] Injecting message: "${triggerMsg}"`);
    await harness.injectMessage(
      'admin:smoke-group',
      triggerMsg,
      'admin:user123',
    );

    console.log('[smoke] Waiting for response (awaitCount=1, timeout=90s)...');
    const responses = await harness.waitForResponse(
      'admin:smoke-group',
      since,
      { awaitCount: 1, timeoutMs: 90000 },
    );

    console.log(`[smoke] Got ${responses.length} response(s)`);
    if (responses.length > 0) {
      console.log(`[smoke] Response (truncated): "${responses[0].substring(0, 200)}"`);
    }
    expect(responses.length).toBeGreaterThan(0);
    expect(responses[0]).toContain('4');
    console.log('[smoke] --- Test passed ---');
  }, 120000);
});
