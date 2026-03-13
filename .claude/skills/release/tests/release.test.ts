import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('release skill package', () => {
  const skillDir = path.resolve(import.meta.dirname, '..');
  const content = fs.readFileSync(
    path.join(skillDir, 'SKILL.md'),
    'utf-8',
  );

  it('has a valid SKILL.md with frontmatter', () => {
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('name: release');
  });

  it('runs steps in correct order: build → test → backup → restart → rebuild → verify', () => {
    const steps = [
      '## 1. Build',
      '## 2. Test',
      '## 3. Backup',
      '## 4. Restart Host Service',
      '## 5. Rebuild Container Image',
      '## 6. Verify',
    ];
    let lastPos = -1;
    for (const step of steps) {
      const pos = content.indexOf(step);
      expect(pos, `${step} should exist`).toBeGreaterThan(-1);
      expect(pos, `${step} should come after previous step`).toBeGreaterThan(lastPos);
      lastPos = pos;
    }
  });

  it('includes test step with vitest', () => {
    expect(content).toContain('npx vitest run');
    expect(content).toContain('Stop immediately if any test fails');
  });

  it('backup copies database and dist, then verifies integrity', () => {
    expect(content).toContain('store/messages.db');
    expect(content).toContain('cp -r dist');
    expect(content).toContain('PRAGMA integrity_check');
  });

  it('backup must succeed before proceeding', () => {
    const backupPos = content.indexOf('## 3. Backup');
    const restartPos = content.indexOf('## 4. Restart');
    const between = content.slice(backupPos, restartPos);
    expect(between).toMatch(/stop.*not proceed|do not proceed/i);
  });

  it('covers both macOS and Linux service managers', () => {
    expect(content).toContain('launchctl');
    expect(content).toContain('systemctl');
  });

  it('includes container rebuild step', () => {
    expect(content).toContain('./container/build.sh');
  });

  it('documents migration semantics for host and containers', () => {
    expect(content).toContain('runMigrations');
    expect(content).toContain('transaction');
    expect(content).toMatch(/container.*not.*access.*database|container.*independent.*migration/i);
  });

  it('includes log check for migration verification', () => {
    expect(content).toContain('nanoclaw.log');
    expect(content).toContain('journalctl');
  });

  it('has a restore-from-backup section with full recipe', () => {
    expect(content).toContain('## Restore from Backup');
    // restore recipe covers: stop, restore DB + dist, restart, verify
    expect(content).toMatch(/restore.*database|restore.*messages\.db/i);
    expect(content).toContain('schema_migrations');
  });
});
