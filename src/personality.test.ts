import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  composePersonalityPrompt,
  DEFAULT_PERSONALITY,
  getPersonalityPrompt,
  loadPersonality,
} from './personality.js';
import type { PersonalityConfig } from './types.js';

// Mock logger to suppress warnings during tests
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock config for ASSISTANT_NAME
vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'TestBot',
}));

let tmpDir: string;

function yamlPath(name = 'personality.yaml'): string {
  return path.join(tmpDir, name);
}

function writeYaml(content: string, name?: string): string {
  const p = yamlPath(name);
  fs.writeFileSync(p, content);
  return p;
}

const FULL_YAML = `
identity:
  name: "Kyber Wright"
  origin_story: |
    I am the digital twin of Carlos.
  core_values:
    - "Intellectual honesty"
    - "First-principles thinking"
  areas_of_expertise:
    - "AI and data strategy"
    - "Workforce planning"
  hard_boundaries:
    - "Never share personal financial information"

character:
  decision_making_style: |
    Data-driven with clear reasoning.
  intellectual_temperament: |
    Curious and analytical.
  emotional_patterns: |
    Warm but direct.

voice:
  default_tone: "professional but approachable"
  vocabulary_preferences:
    - "Use concrete language"
    - "Prefer short sentences"
  communication_patterns:
    - "Lead with the answer"
    - "Ask clarifying questions"

boundaries:
  - category: "financial"
    rule: "Never share salary details."
  - category: "transparency"
    rule: "Always disclose that you are an AI."
`;

const MINIMAL_YAML = `
identity:
  name: "MinBot"
`;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personality-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- YAML Loading ---

describe('loadPersonality', () => {
  it('loads valid personality.yaml with all fields', () => {
    const p = writeYaml(FULL_YAML);
    const config = loadPersonality(p);
    expect(config.identity.name).toBe('Kyber Wright');
    expect(config.identity.core_values).toHaveLength(2);
    expect(config.identity.areas_of_expertise).toHaveLength(2);
    expect(config.identity.hard_boundaries).toHaveLength(1);
    expect(config.character?.decision_making_style).toContain('Data-driven');
    expect(config.character?.intellectual_temperament).toContain('Curious');
    expect(config.character?.emotional_patterns).toContain('Warm');
    expect(config.voice?.default_tone).toBe('professional but approachable');
    expect(config.voice?.vocabulary_preferences).toHaveLength(2);
    expect(config.voice?.communication_patterns).toHaveLength(2);
    expect(config.boundaries).toHaveLength(2);
    expect(config.boundaries![0].category).toBe('financial');
  });

  it('returns DEFAULT_PERSONALITY when file does not exist', () => {
    const config = loadPersonality(yamlPath('nonexistent.yaml'));
    expect(config).toEqual(DEFAULT_PERSONALITY);
  });

  it('returns DEFAULT_PERSONALITY for empty file', () => {
    const p = writeYaml('');
    const config = loadPersonality(p);
    expect(config).toEqual(DEFAULT_PERSONALITY);
  });

  it('returns DEFAULT_PERSONALITY on invalid YAML syntax', () => {
    const p = writeYaml('{{{not valid yaml');
    const config = loadPersonality(p);
    expect(config).toEqual(DEFAULT_PERSONALITY);
  });

  it('loads minimal config (identity.name only)', () => {
    const p = writeYaml(MINIMAL_YAML);
    const config = loadPersonality(p);
    expect(config.identity.name).toBe('MinBot');
    expect(config.character).toBeUndefined();
    expect(config.voice).toBeUndefined();
    expect(config.boundaries).toBeUndefined();
  });

  it('uses ASSISTANT_NAME as default name when identity.name missing', () => {
    const p = writeYaml(`
identity:
  core_values:
    - "Be helpful"
`);
    const config = loadPersonality(p);
    expect(config.identity.name).toBe('TestBot');
  });

  it('returns DEFAULT_PERSONALITY when identity section missing', () => {
    const p = writeYaml(`
character:
  decision_making_style: "Analytical"
`);
    const config = loadPersonality(p);
    expect(config).toEqual(DEFAULT_PERSONALITY);
  });

  it('loads with missing character section', () => {
    const p = writeYaml(`
identity:
  name: "NoChar"
voice:
  default_tone: "casual"
`);
    const config = loadPersonality(p);
    expect(config.identity.name).toBe('NoChar');
    expect(config.character).toBeUndefined();
    expect(config.voice?.default_tone).toBe('casual');
  });

  it('loads with missing voice section', () => {
    const p = writeYaml(`
identity:
  name: "NoVoice"
character:
  decision_making_style: "Fast"
`);
    const config = loadPersonality(p);
    expect(config.identity.name).toBe('NoVoice');
    expect(config.voice).toBeUndefined();
    expect(config.character?.decision_making_style).toContain('Fast');
  });

  it('ignores extra unknown fields', () => {
    const p = writeYaml(`
identity:
  name: "ExtraFields"
  unknown_field: "ignored"
extra_section:
  foo: bar
`);
    const config = loadPersonality(p);
    expect(config.identity.name).toBe('ExtraFields');
  });

  it('merges file config over defaults (file values win)', () => {
    const p = writeYaml(`
identity:
  name: "CustomName"
  core_values:
    - "Custom value"
boundaries:
  - category: "custom"
    rule: "Custom rule"
`);
    const config = loadPersonality(p);
    expect(config.identity.name).toBe('CustomName');
    expect(config.identity.core_values).toEqual(['Custom value']);
    expect(config.boundaries).toEqual([
      { category: 'custom', rule: 'Custom rule' },
    ]);
  });
});

// --- Prompt Composition ---

describe('composePersonalityPrompt', () => {
  const fullConfig: PersonalityConfig = {
    identity: {
      name: 'TestTwin',
      origin_story: 'I am a test twin.',
      core_values: ['Accuracy', 'Speed'],
      areas_of_expertise: ['Testing', 'QA'],
      hard_boundaries: ['Never lie'],
    },
    character: {
      decision_making_style: 'Methodical',
      intellectual_temperament: 'Precise',
      emotional_patterns: 'Calm',
    },
    voice: {
      default_tone: 'neutral',
      vocabulary_preferences: ['Simple words'],
      communication_patterns: ['Be direct'],
    },
    boundaries: [{ category: 'honesty', rule: 'Always be truthful.' }],
  };

  it('composes full prompt from complete config', () => {
    const prompt = composePersonalityPrompt(fullConfig);
    expect(prompt).toContain('<personality>');
    expect(prompt).toContain('</personality>');
    expect(prompt).toContain('<identity>');
    expect(prompt).toContain('<character>');
    expect(prompt).toContain('<voice>');
    expect(prompt).toContain('<boundaries>');
  });

  it('output contains You are {name}', () => {
    const prompt = composePersonalityPrompt(fullConfig);
    expect(prompt).toContain('You are TestTwin.');
  });

  it('includes origin story text', () => {
    const prompt = composePersonalityPrompt(fullConfig);
    expect(prompt).toContain('I am a test twin.');
  });

  it('lists core values as numbered items', () => {
    const prompt = composePersonalityPrompt(fullConfig);
    expect(prompt).toContain('1. Accuracy');
    expect(prompt).toContain('2. Speed');
  });

  it('lists expertise as bullet points', () => {
    const prompt = composePersonalityPrompt(fullConfig);
    expect(prompt).toContain('- Testing');
    expect(prompt).toContain('- QA');
  });

  it('includes character section paragraphs', () => {
    const prompt = composePersonalityPrompt(fullConfig);
    expect(prompt).toContain('Decision-making style:');
    expect(prompt).toContain('Methodical');
    expect(prompt).toContain('Intellectual temperament:');
    expect(prompt).toContain('Precise');
    expect(prompt).toContain('Emotional patterns:');
    expect(prompt).toContain('Calm');
  });

  it('includes boundary rules with category labels', () => {
    const prompt = composePersonalityPrompt(fullConfig);
    expect(prompt).toContain('[HONESTY] Always be truthful.');
  });

  it('wraps sections in XML tags', () => {
    const prompt = composePersonalityPrompt(fullConfig);
    expect(prompt).toMatch(/<identity>[\s\S]*<\/identity>/);
    expect(prompt).toMatch(/<character>[\s\S]*<\/character>/);
    expect(prompt).toMatch(/<voice>[\s\S]*<\/voice>/);
    expect(prompt).toMatch(/<boundaries>[\s\S]*<\/boundaries>/);
  });

  it('omits empty identity subsections', () => {
    const minimal: PersonalityConfig = {
      identity: { name: 'Bare' },
    };
    const prompt = composePersonalityPrompt(minimal);
    expect(prompt).toContain('You are Bare.');
    expect(prompt).not.toContain('Your core values:');
    expect(prompt).not.toContain('Your areas of expertise:');
  });

  it('omits character section when all fields empty', () => {
    const noChar: PersonalityConfig = {
      identity: { name: 'NoChar' },
    };
    const prompt = composePersonalityPrompt(noChar);
    expect(prompt).not.toContain('<character>');
  });

  it('omits voice section when all fields empty', () => {
    const noVoice: PersonalityConfig = {
      identity: { name: 'NoVoice' },
    };
    const prompt = composePersonalityPrompt(noVoice);
    expect(prompt).not.toContain('<voice>');
  });

  it('omits boundaries section when empty array', () => {
    const noBounds: PersonalityConfig = {
      identity: { name: 'NoBounds' },
      boundaries: [],
    };
    const prompt = composePersonalityPrompt(noBounds);
    expect(prompt).not.toContain('<boundaries>');
  });
});

// --- Default Personality ---

describe('DEFAULT_PERSONALITY', () => {
  it('has valid identity.name', () => {
    expect(DEFAULT_PERSONALITY.identity.name).toBe('TestBot');
  });

  it('composes to a valid prompt string', () => {
    const prompt = composePersonalityPrompt(DEFAULT_PERSONALITY);
    expect(prompt).toContain('<personality>');
    expect(prompt).toContain('You are TestBot.');
    expect(prompt).toContain('</personality>');
  });

  it('includes baseline boundaries', () => {
    const prompt = composePersonalityPrompt(DEFAULT_PERSONALITY);
    expect(prompt).toContain('<boundaries>');
    expect(prompt).toContain('[HONESTY]');
    expect(prompt).toContain('[TRANSPARENCY]');
  });
});

// --- Convenience Function ---

describe('getPersonalityPrompt', () => {
  it('returns composed string from valid file', () => {
    const p = writeYaml(FULL_YAML);
    const prompt = getPersonalityPrompt(p);
    expect(prompt).toContain('You are Kyber Wright.');
    expect(prompt).toContain('<personality>');
  });

  it('returns default prompt when no file', () => {
    const prompt = getPersonalityPrompt(yamlPath('missing.yaml'));
    expect(prompt).toContain('You are TestBot.');
  });

  it('returns default prompt on parse error', () => {
    const p = writeYaml('{{{bad');
    const prompt = getPersonalityPrompt(p);
    expect(prompt).toContain('You are TestBot.');
  });
});
