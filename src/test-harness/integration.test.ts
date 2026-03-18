import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { IntegrationHarness } from './harness.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('integration: admin channel', () => {
  let harness: IntegrationHarness;
  let triggerName: string;

  beforeAll(async () => {
    console.log('[test] === Setting up integration test suite ===');
    harness = new IntegrationHarness({
      adminPort: 9877,
      mockApiPort: 9876,
    });

    console.log('[test] Starting harness...');
    await harness.start();
    console.log('[test] Harness started');

    // Discover the host's assistant name for trigger messages
    triggerName = await harness.getAssistantName();
    console.log(`[test] Host assistant name: "${triggerName}" (trigger: @${triggerName})`);

    // Register a test group
    console.log('[test] Registering test group...');
    await harness.registerGroup('admin:test-group', {
      name: 'Test Group',
      folder: 'test-integration',
      trigger: `@${triggerName}`,
      requiresTrigger: true,
    });
    console.log('[test] Test group registered');
    console.log('[test] === Setup complete ===');
  }, 60000);

  afterAll(async () => {
    console.log('[test] === Tearing down integration test suite ===');
    await harness.stop();
    console.log('[test] === Teardown complete ===');
  }, 15000);

  it('ignores messages without trigger in requiresTrigger group', async () => {
    console.log('[test] --- Test: ignores messages without trigger ---');
    const since = new Date().toISOString();
    console.log(`[test] Since timestamp: ${since}`);

    console.log('[test] Injecting message without trigger: "hello world"');
    await harness.injectMessage('admin:test-group', 'hello world', 'admin:user123');

    console.log('[test] Sleeping 3s to let message loop process...');
    await sleep(3000);

    console.log('[test] Checking for responses (expecting none)...');
    const responses = await harness.waitForResponse('admin:test-group', since);
    console.log(`[test] Got ${responses.length} response(s) — expected 0`);
    expect(responses).toHaveLength(0);
    console.log('[test] --- Test passed ---');
  }, 10000);

  it('processes trigger and returns agent response', async () => {
    const triggerMsg = `@${triggerName} hello`;
    console.log(`[test] --- Test: "${triggerMsg}" trigger → agent response ---`);
    const since = new Date().toISOString();
    console.log(`[test] Since timestamp: ${since}`);

    console.log(`[test] Injecting message with trigger: "${triggerMsg}"`);
    await harness.injectMessage('admin:test-group', triggerMsg, 'admin:user123');

    console.log('[test] Waiting for response (awaitCount=1, timeout=90s)...');
    const responses = await harness.waitForResponse('admin:test-group', since, {
      awaitCount: 1,
      timeoutMs: 90000,
    });

    console.log(`[test] Got ${responses.length} response(s)`);
    if (responses.length > 0) {
      console.log(`[test] First response (truncated): "${responses[0].substring(0, 200)}"`);
    }
    expect(responses.length).toBeGreaterThan(0);
    expect(responses[0]).toBeTruthy();
    console.log('[test] --- Test passed ---');
  }, 120000);
});

// CI_SMOKE: runs with real Anthropic API when CI_SMOKE=true
const describeSmoke =
  process.env.CI_SMOKE === 'true' ? describe : describe.skip;

describeSmoke('smoke: real API', () => {
  let smokeHarness: IntegrationHarness;
  let triggerName: string;

  beforeAll(async () => {
    console.log('[smoke] === Setting up smoke test suite ===');
    smokeHarness = new IntegrationHarness({
      adminPort: 9878,
      mockApiPort: 0, // 0 = no mock, use real ANTHROPIC_API_KEY from .env
    });

    console.log('[smoke] Starting harness (real API)...');
    await smokeHarness.start();
    console.log('[smoke] Harness started');

    triggerName = await smokeHarness.getAssistantName();
    console.log(`[smoke] Host assistant name: "${triggerName}"`);

    console.log('[smoke] Registering smoke group...');
    await smokeHarness.registerGroup('admin:smoke-group', {
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
    await smokeHarness.stop();
    console.log('[smoke] === Teardown complete ===');
  }, 15000);

  it('gets real Claude response', async () => {
    console.log('[smoke] --- Test: real Claude response ---');
    const since = new Date().toISOString();
    console.log(`[smoke] Since timestamp: ${since}`);

    const triggerMsg = `@${triggerName} say hello`;
    console.log(`[smoke] Injecting message: "${triggerMsg}"`);
    await smokeHarness.injectMessage(
      'admin:smoke-group',
      triggerMsg,
      'admin:user123',
    );

    console.log('[smoke] Waiting for response (awaitCount=1, timeout=90s)...');
    const responses = await smokeHarness.waitForResponse(
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
});
