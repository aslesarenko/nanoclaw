/**
 * Personality Engine for NanoClaw.
 *
 * Loads a structured YAML personality definition and composes
 * a system prompt from identity, character, voice, and boundary layers.
 * Always returns a valid config — falls back to DEFAULT_PERSONALITY
 * when no file exists or the file is invalid.
 */
import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';

import { ASSISTANT_NAME } from './config.js';
import { logger } from './logger.js';
import type {
  PersonalityBoundary,
  PersonalityCharacter,
  PersonalityConfig,
  PersonalityIdentity,
  PersonalityVoice,
} from './types.js';

export type { PersonalityConfig } from './types.js';

// --- Default personality ---

export const DEFAULT_PERSONALITY: PersonalityConfig = {
  identity: {
    name: ASSISTANT_NAME,
    core_values: [
      'Be helpful, accurate, and honest',
      "Respect the user's time — be concise and action-oriented",
    ],
    hard_boundaries: ['When uncertain, say so rather than guessing'],
  },
  boundaries: [
    {
      category: 'honesty',
      rule: 'When uncertain about facts, explicitly state your uncertainty.',
    },
    {
      category: 'transparency',
      rule: 'Always disclose that you are an AI when directly asked.',
    },
  ],
};

const DEFAULT_PATH = path.resolve(process.cwd(), 'config', 'personality.yaml');

// --- Load ---

export function loadPersonality(pathOverride?: string): PersonalityConfig {
  const filePath = pathOverride ?? DEFAULT_PATH;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return DEFAULT_PERSONALITY;
  }

  if (!raw.trim()) {
    return DEFAULT_PERSONALITY;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to parse personality YAML');
    return DEFAULT_PERSONALITY;
  }

  if (!parsed || typeof parsed !== 'object') {
    return DEFAULT_PERSONALITY;
  }

  const doc = parsed as Record<string, unknown>;

  const identity = parseIdentity(doc.identity);
  if (!identity) {
    return DEFAULT_PERSONALITY;
  }

  return {
    identity,
    character: parseCharacter(doc.character),
    voice: parseVoice(doc.voice),
    boundaries: parseBoundaries(doc.boundaries),
  };
}

// --- Compose ---

export function composePersonalityPrompt(config: PersonalityConfig): string {
  const sections: string[] = [];

  // Identity
  const identityParts: string[] = [];
  identityParts.push(`You are ${config.identity.name}.`);

  if (config.identity.origin_story?.trim()) {
    identityParts.push('');
    identityParts.push(config.identity.origin_story.trim());
  }

  if (config.identity.core_values && config.identity.core_values.length > 0) {
    identityParts.push('');
    identityParts.push('Your core values:');
    config.identity.core_values.forEach((v, i) => {
      identityParts.push(`${i + 1}. ${v}`);
    });
  }

  if (
    config.identity.areas_of_expertise &&
    config.identity.areas_of_expertise.length > 0
  ) {
    identityParts.push('');
    identityParts.push('Your areas of expertise:');
    config.identity.areas_of_expertise.forEach((a) => {
      identityParts.push(`- ${a}`);
    });
  }

  sections.push(`<identity>\n${identityParts.join('\n')}\n</identity>`);

  // Character
  const charParts: string[] = [];
  if (config.character?.decision_making_style?.trim()) {
    charParts.push('Decision-making style:');
    charParts.push(config.character.decision_making_style.trim());
  }
  if (config.character?.intellectual_temperament?.trim()) {
    if (charParts.length > 0) charParts.push('');
    charParts.push('Intellectual temperament:');
    charParts.push(config.character.intellectual_temperament.trim());
  }
  if (config.character?.emotional_patterns?.trim()) {
    if (charParts.length > 0) charParts.push('');
    charParts.push('Emotional patterns:');
    charParts.push(config.character.emotional_patterns.trim());
  }
  if (charParts.length > 0) {
    sections.push(`<character>\n${charParts.join('\n')}\n</character>`);
  }

  // Voice
  const voiceParts: string[] = [];
  if (config.voice?.default_tone?.trim()) {
    voiceParts.push(
      `Your default tone is: ${config.voice.default_tone.trim()}`,
    );
  }
  if (
    config.voice?.vocabulary_preferences &&
    config.voice.vocabulary_preferences.length > 0
  ) {
    if (voiceParts.length > 0) voiceParts.push('');
    voiceParts.push('Vocabulary preferences:');
    config.voice.vocabulary_preferences.forEach((p) => {
      voiceParts.push(`- ${p}`);
    });
  }
  if (
    config.voice?.communication_patterns &&
    config.voice.communication_patterns.length > 0
  ) {
    if (voiceParts.length > 0) voiceParts.push('');
    voiceParts.push('Communication patterns:');
    config.voice.communication_patterns.forEach((p) => {
      voiceParts.push(`- ${p}`);
    });
  }
  if (voiceParts.length > 0) {
    sections.push(`<voice>\n${voiceParts.join('\n')}\n</voice>`);
  }

  // Boundaries (from both identity.hard_boundaries and top-level boundaries)
  const boundaryLines: string[] = [];
  if (
    config.identity.hard_boundaries &&
    config.identity.hard_boundaries.length > 0
  ) {
    config.identity.hard_boundaries.forEach((b) => {
      boundaryLines.push(`- ${b}`);
    });
  }
  if (config.boundaries && config.boundaries.length > 0) {
    config.boundaries.forEach((b) => {
      boundaryLines.push(`[${b.category.toUpperCase()}] ${b.rule}`);
    });
  }
  if (boundaryLines.length > 0) {
    sections.push(
      `<boundaries>\nHARD BOUNDARIES — You must ALWAYS follow these rules:\n\n${boundaryLines.join('\n')}\n</boundaries>`,
    );
  }

  return `<personality>\n${sections.join('\n\n')}\n</personality>`;
}

// --- Convenience ---

export function getPersonalityPrompt(pathOverride?: string): string {
  const config = loadPersonality(pathOverride);
  return composePersonalityPrompt(config);
}

// --- Parsers ---

function parseIdentity(raw: unknown): PersonalityIdentity | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const name =
    typeof obj.name === 'string' && obj.name.trim()
      ? obj.name.trim()
      : ASSISTANT_NAME;

  return {
    name,
    origin_story:
      typeof obj.origin_story === 'string' ? obj.origin_story : undefined,
    core_values: asStringArray(obj.core_values),
    areas_of_expertise: asStringArray(obj.areas_of_expertise),
    hard_boundaries: asStringArray(obj.hard_boundaries),
  };
}

function parseCharacter(raw: unknown): PersonalityCharacter | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const result: PersonalityCharacter = {};

  if (typeof obj.decision_making_style === 'string')
    result.decision_making_style = obj.decision_making_style;
  if (typeof obj.intellectual_temperament === 'string')
    result.intellectual_temperament = obj.intellectual_temperament;
  if (typeof obj.emotional_patterns === 'string')
    result.emotional_patterns = obj.emotional_patterns;

  return Object.keys(result).length > 0 ? result : undefined;
}

function parseVoice(raw: unknown): PersonalityVoice | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const result: PersonalityVoice = {};

  if (typeof obj.default_tone === 'string')
    result.default_tone = obj.default_tone;
  if (Array.isArray(obj.vocabulary_preferences))
    result.vocabulary_preferences = asStringArray(obj.vocabulary_preferences);
  if (Array.isArray(obj.communication_patterns))
    result.communication_patterns = asStringArray(obj.communication_patterns);

  return Object.keys(result).length > 0 ? result : undefined;
}

function parseBoundaries(raw: unknown): PersonalityBoundary[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result: PersonalityBoundary[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>).category === 'string' &&
      typeof (item as Record<string, unknown>).rule === 'string'
    ) {
      result.push({
        category: (item as Record<string, string>).category,
        rule: (item as Record<string, string>).rule,
      });
    }
  }
  return result.length > 0 ? result : undefined;
}

function asStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const strings = raw.filter((v): v is string => typeof v === 'string');
  return strings.length > 0 ? strings : undefined;
}
