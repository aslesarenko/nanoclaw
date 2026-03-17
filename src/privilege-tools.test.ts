/**
 * Tests for privilege-to-tool mapping (Extension C).
 *
 * Validates that each privilege level receives the correct tool set,
 * ensuring code-enforced access control boundaries. These tests are
 * the specification for what each privilege level can and cannot do.
 */
import { describe, it, expect } from 'vitest';
import { getAllowedToolsForPrivilege } from './privilege-tools.js';

describe('getAllowedToolsForPrivilege', () => {
  // --- Owner privilege ---

  describe('owner', () => {
    it('includes full tool set', () => {
      const tools = getAllowedToolsForPrivilege('owner');
      expect(tools).toContain('Bash');
      expect(tools).toContain('Read');
      expect(tools).toContain('Write');
      expect(tools).toContain('Edit');
      expect(tools).toContain('Glob');
      expect(tools).toContain('Grep');
      expect(tools).toContain('WebSearch');
      expect(tools).toContain('WebFetch');
      expect(tools).toContain('Task');
      expect(tools).toContain('TaskOutput');
      expect(tools).toContain('TaskStop');
      expect(tools).toContain('TeamCreate');
      expect(tools).toContain('TeamDelete');
      expect(tools).toContain('SendMessage');
      expect(tools).toContain('TodoWrite');
      expect(tools).toContain('ToolSearch');
      expect(tools).toContain('Skill');
      expect(tools).toContain('NotebookEdit');
      expect(tools).toContain('mcp__nanoclaw__*');
    });

    it('includes Gmail MCP', () => {
      const tools = getAllowedToolsForPrivilege('owner');
      expect(tools).toContain('mcp__gmail__*');
    });
  });

  // --- Colleague privilege ---

  describe('colleague', () => {
    it('includes core tools', () => {
      const tools = getAllowedToolsForPrivilege('colleague');
      expect(tools).toContain('Bash');
      expect(tools).toContain('Read');
      expect(tools).toContain('Write');
      expect(tools).toContain('Edit');
      expect(tools).toContain('WebSearch');
      expect(tools).toContain('Task');
      expect(tools).toContain('TeamCreate');
      expect(tools).toContain('mcp__nanoclaw__*');
    });

    it('excludes Gmail MCP', () => {
      const tools = getAllowedToolsForPrivilege('colleague');
      expect(tools).not.toContain('mcp__gmail__*');
    });
  });

  // --- External privilege ---

  describe('external', () => {
    it('includes read-only tools', () => {
      const tools = getAllowedToolsForPrivilege('external');
      expect(tools).toContain('Bash');
      expect(tools).toContain('Read');
      expect(tools).toContain('Glob');
      expect(tools).toContain('Grep');
      expect(tools).toContain('WebSearch');
      expect(tools).toContain('WebFetch');
      expect(tools).toContain('mcp__nanoclaw__*');
    });

    it('excludes write tools', () => {
      const tools = getAllowedToolsForPrivilege('external');
      expect(tools).not.toContain('Write');
      expect(tools).not.toContain('Edit');
      expect(tools).not.toContain('NotebookEdit');
    });

    it('excludes task orchestration tools', () => {
      const tools = getAllowedToolsForPrivilege('external');
      expect(tools).not.toContain('Task');
      expect(tools).not.toContain('TaskOutput');
      expect(tools).not.toContain('TaskStop');
    });

    it('excludes agent team tools', () => {
      const tools = getAllowedToolsForPrivilege('external');
      expect(tools).not.toContain('TeamCreate');
      expect(tools).not.toContain('TeamDelete');
      expect(tools).not.toContain('SendMessage');
    });

    it('excludes Gmail MCP', () => {
      const tools = getAllowedToolsForPrivilege('external');
      expect(tools).not.toContain('mcp__gmail__*');
    });
  });

  // --- General properties ---

  it('all privilege levels return non-empty arrays', () => {
    expect(getAllowedToolsForPrivilege('owner').length).toBeGreaterThan(0);
    expect(getAllowedToolsForPrivilege('colleague').length).toBeGreaterThan(0);
    expect(getAllowedToolsForPrivilege('external').length).toBeGreaterThan(0);
  });

  it('returns new arrays each call (no shared references)', () => {
    const a = getAllowedToolsForPrivilege('owner');
    const b = getAllowedToolsForPrivilege('owner');
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('owner has strictly more tools than colleague', () => {
    const owner = getAllowedToolsForPrivilege('owner');
    const colleague = getAllowedToolsForPrivilege('colleague');
    expect(owner.length).toBeGreaterThan(colleague.length);
    // Every colleague tool should also be in owner
    for (const tool of colleague) {
      expect(owner).toContain(tool);
    }
  });

  it('colleague has strictly more tools than external', () => {
    const colleague = getAllowedToolsForPrivilege('colleague');
    const external = getAllowedToolsForPrivilege('external');
    expect(colleague.length).toBeGreaterThan(external.length);
    // Every external tool should also be in colleague
    for (const tool of external) {
      expect(colleague).toContain(tool);
    }
  });
});
