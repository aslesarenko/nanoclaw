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
      adminPort: 9879,   // different from production (9877) — mock needs its own host
      mockApiPort: 9876,
    });

    console.log('[test] Starting harness...');
    await harness.start();
    console.log('[test] Harness started');

    // Discover the host's assistant name for trigger messages
    triggerName = harness.getAssistantName();
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

