import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('integration-test skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid SKILL.md with frontmatter', () => {
    const skillPath = path.join(skillDir, 'SKILL.md');
    expect(fs.existsSync(skillPath)).toBe(true);
    const content = fs.readFileSync(skillPath, 'utf-8');
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('name: integration-test');
  });

  it('has trigger keywords in description', () => {
    const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(content).toContain('integration test');
    expect(content).toContain('test privileges');
  });

  it('covers all test phases', () => {
    const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(content).toContain('Phase 0: Setup');
    expect(content).toContain('Phase 1: Mode 2 Baseline');
    expect(content).toContain('Phase 2: Mode 1 Basics');
    expect(content).toContain('Phase 3: Multi-Sender Privilege');
    expect(content).toContain('Phase 4: Mode 2 Floor Degradation');
    expect(content).toContain('Phase 5: Task Creator Privilege');
  });

  it('includes all 15 test cases', () => {
    const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const testHeaders = content.match(/### Test \d+\.\d+/g) ?? [];
    expect(testHeaders.length).toBeGreaterThanOrEqual(15);
  });

  it('includes pass criteria for each test', () => {
    const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const passCriteria = content.match(/\*\*Pass criteria:\*\*/g) ?? [];
    expect(passCriteria.length).toBeGreaterThanOrEqual(10);
  });

  it('includes self-reflection phase', () => {
    const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(content).toContain('Self-Reflection');
    expect(content).toContain('Proposed fix');
  });

  it('includes issues review phase', () => {
    const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(content).toContain('Issues Review');
    expect(content).toContain('extension-c-test-issues.md');
  });

  it('includes cleanup phase', () => {
    const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(content).toContain('Final Cleanup');
    expect(content).toContain('DELETE FROM messages WHERE id IN');
  });

  it('includes troubleshooting section', () => {
    const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(content).toContain('## Troubleshooting');
    expect(content).toContain('Agent doesn\'t respond to trigger');
    expect(content).toContain('Gmail available to colleague');
  });

  it('references critical source files', () => {
    const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(content).toContain('src/index.ts');
    expect(content).toContain('src/privilege-resolver.ts');
    expect(content).toContain('src/privilege-tools.ts');
    expect(content).toContain('container/agent-runner/src/index.ts');
  });

  it('documents the Telegram trigger translation', () => {
    const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(content).toContain('@morphic_ai_bot');
    expect(content).toContain('@AlexTwin');
    expect(content).toContain('TRIGGER_PATTERN');
  });
});
