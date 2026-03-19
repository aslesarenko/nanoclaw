import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('status-report skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid SKILL.md with frontmatter', () => {
    const skillPath = path.join(skillDir, 'SKILL.md');
    expect(fs.existsSync(skillPath)).toBe(true);
    const content = fs.readFileSync(skillPath, 'utf-8');
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('name: status-report');
    expect(content).toContain('description:');
  });

  it('has correct skill name in frontmatter', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'SKILL.md'),
      'utf-8',
    );
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatterMatch).not.toBeNull();
    const frontmatter = frontmatterMatch![1];
    expect(frontmatter).toContain('name: status-report');
  });

  it('has trigger keywords in description', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'SKILL.md'),
      'utf-8',
    );
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    const frontmatter = frontmatterMatch![1];
    expect(frontmatter).toMatch(/status report/i);
    expect(frontmatter).toMatch(/weekly report/i);
  });

  it('documents the three data sources', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'SKILL.md'),
      'utf-8',
    );
    // Must mention all three data collection sources
    expect(content).toMatch(/git/i);
    expect(content).toMatch(/claude code session/i);
    expect(content).toMatch(/admin.*channel|REST API/i);
  });

  it('documents the report structure sections', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'SKILL.md'),
      'utf-8',
    );
    // Required report sections
    expect(content).toMatch(/what went well/i);
    expect(content).toMatch(/priorities.*next week|top 3 priorities/i);
    expect(content).toMatch(/next big thing/i);
    expect(content).toMatch(/key decisions.*blockers.*risks/i);
    expect(content).toMatch(/action items.*follow-ups/i);
  });

  it('documents the AdminChannel REST API endpoints used', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'SKILL.md'),
      'utf-8',
    );
    // Must reference the specific endpoints
    expect(content).toContain('/health');
    expect(content).toContain('/groups');
    expect(content).toContain('/messages');
    expect(content).toContain('/responses');
  });

  it('documents the JSONL session format', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'SKILL.md'),
      'utf-8',
    );
    expect(content).toContain('.jsonl');
    expect(content).toContain('~/.claude/projects/');
  });

  it('has a troubleshooting section', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'SKILL.md'),
      'utf-8',
    );
    expect(content).toMatch(/## Troubleshooting/);
  });

  it('handles graceful degradation when AdminChannel is unavailable', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'SKILL.md'),
      'utf-8',
    );
    // Should document what happens when the admin channel is down
    expect(content).toMatch(/partial report|proceed without/i);
  });

  it('handles agent response timeout', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'SKILL.md'),
      'utf-8',
    );
    expect(content).toMatch(/timeout/i);
    expect(content).toMatch(/timed.?out/i);
  });
});
