import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('migrate-session skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid SKILL.md with frontmatter', () => {
    const skillPath = path.join(skillDir, 'SKILL.md');
    expect(fs.existsSync(skillPath)).toBe(true);
    const content = fs.readFileSync(skillPath, 'utf-8');
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('name: migrate-session');
    expect(content).toContain('description:');
  });

  it('is an interactive skill (no manifest.yaml)', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(false);
  });

  it('covers all critical steps', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'SKILL.md'),
      'utf-8',
    );

    // Must validate group exists
    expect(content).toContain('Step 1');
    expect(content).toMatch(/validate/i);

    // Must locate session file
    expect(content).toContain('sessions');
    expect(content).toContain('.jsonl');

    // Must summarize session into separate file
    expect(content).toMatch(/summarize|summary/i);
    expect(content).toContain('sessions/session-summary-');
    expect(content).toContain('CLAUDE.md');

    // Must add reference in CLAUDE.md, not inline the summary
    expect(content).toContain('Session History');

    // Must stop container before clearing session (race condition)
    expect(content).toMatch(/stop.*container/i);
    expect(content).toContain('docker stop');

    // Must clear session from DB
    expect(content).toContain('DELETE FROM sessions');

    // Must restart host
    expect(content).toMatch(/restart/i);
    expect(content).toContain('launchctl kickstart');

    // Must verify
    expect(content).toMatch(/verify/i);

    // Must include self-reflection step
    expect(content).toContain('Self-Reflection');
    expect(content).toMatch(/Proposed fix/i);
  });

  it('documents the race condition warning', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'SKILL.md'),
      'utf-8',
    );
    // The SKILL.md must warn about the container exit handler race condition
    expect(content).toMatch(/race condition|exit handler|re-write|re-appear/i);
  });

  it('includes troubleshooting section', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'SKILL.md'),
      'utf-8',
    );
    expect(content).toMatch(/## Troubleshooting/);
  });

  it('mentions the session JSONL file path pattern', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'SKILL.md'),
      'utf-8',
    );
    expect(content).toContain('data/sessions/{GROUP_FOLDER}/.claude/projects/-workspace-group/{SESSION_ID}.jsonl');
  });
});
