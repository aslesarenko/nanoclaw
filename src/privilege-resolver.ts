/**
 * Privilege Resolver for NanoClaw (Extension C)
 *
 * Implements two distinct privilege models based on how a chat activates the agent:
 *
 * **Mode 1 — Privilege-aware chats** (`requiresTrigger !== false`):
 *   The @-mention is a privilege boundary. All messages trigger execution, but:
 *   - @-mention messages → individual invocation at the sender's privilege level
 *   - Non-mention messages → batched invocation at the session floor privilege
 *   Each segment gets its own container invocation with a different tool set,
 *   providing code-enforced privilege isolation.
 *
 * **Mode 2 — Every-message chats** (`requiresTrigger === false`, including main group):
 *   Privilege is the minimum across all senders who have ever participated in the
 *   session. If an external user joins, the entire session degrades. The main group
 *   is always overridden to 'owner'.
 *
 * Design decisions:
 * - Privilege ordering: owner (2) > colleague (1) > external (0).
 * - Unmapped senders default to 'external' (principle of least privilege).
 * - `is_from_me` messages are always treated as 'owner'.
 * - Session floor is stored per group in `router_state` (key: `privilege_floor:{groupFolder}`)
 *   and only degrades — it never increases without an explicit session reset.
 */
import { TRIGGER_PATTERN } from './config.js';
import { getRouterState, setRouterState } from './db.js';
import { resolveIdentity } from './identity.js';
import {
  NewMessage,
  PrivilegeLevel,
  ResolvedIdentity,
} from './types.js';

// --- Privilege ordering ---

/** Numeric rank for privilege levels. Higher = more privileged. */
const PRIVILEGE_RANK: Record<PrivilegeLevel, number> = {
  owner: 2,
  colleague: 1,
  external: 0,
};

const RANK_TO_PRIVILEGE: PrivilegeLevel[] = ['external', 'colleague', 'owner'];

/**
 * Returns the minimum (least privileged) of the given privilege levels.
 *
 * @param levels - One or more privilege levels to compare.
 * @returns The least privileged level among the inputs.
 */
export function minPrivilege(...levels: PrivilegeLevel[]): PrivilegeLevel {
  let minRank = PRIVILEGE_RANK.owner;
  for (const level of levels) {
    const rank = PRIVILEGE_RANK[level];
    if (rank < minRank) minRank = rank;
  }
  return RANK_TO_PRIVILEGE[minRank];
}

// --- Mode 1: Privilege-aware (mention-based) chats ---

/**
 * A segment of messages to process as one invocation.
 * Each segment has a single effective privilege level that determines
 * the tool set available to the agent.
 */
export interface PrivilegeSegment {
  /** Messages in this segment (context batch or single mention). */
  messages: NewMessage[];
  /** Effective privilege for this invocation — gates tools and mounts. */
  effectivePrivilege: PrivilegeLevel;
  /** Identity of the primary sender (trigger sender for mentions, last sender for batches). */
  primarySender: string;
  primarySenderName: string;
  /** Resolved identity of the primary sender, or null if unmapped. */
  primaryResolvedIdentity: ResolvedIdentity | null;
  /** Whether this segment was triggered by an @-mention (true) or is a context batch (false). */
  isMentionTrigger: boolean;
}

/** Result of splitting a message queue into privilege-isolated segments. */
export interface SegmentSplitResult {
  /** Ordered segments — each gets its own container invocation. */
  segments: PrivilegeSegment[];
}

/**
 * Splits a message queue into privilege-isolated segments for Mode 1 chats.
 *
 * Each @-mention becomes its own segment at the sender's privilege level.
 * Consecutive non-mention messages are batched into a single segment at the
 * session floor privilege. This ensures that tool/MCP calls are gated by
 * the privilege of the sender whose message triggers the invocation.
 *
 * @param messages - Chronologically ordered messages to process.
 * @param sessionFloorPrivilege - The session floor privilege for non-mention batches.
 * @returns Ordered segments, each with its own privilege level and tool set.
 */
export function splitMessagesByPrivilege(
  messages: NewMessage[],
  sessionFloorPrivilege: PrivilegeLevel,
): SegmentSplitResult {
  const segments: PrivilegeSegment[] = [];
  let contextBatch: NewMessage[] = [];

  for (const msg of messages) {
    const isMention = TRIGGER_PATTERN.test(msg.content.trim());

    if (isMention) {
      // Flush accumulated non-mention messages as a context batch segment
      if (contextBatch.length > 0) {
        const lastMsg = contextBatch[contextBatch.length - 1];
        const resolved = lastMsg.resolvedIdentity ?? resolveIdentity(lastMsg.sender);
        segments.push({
          messages: contextBatch,
          effectivePrivilege: sessionFloorPrivilege,
          primarySender: lastMsg.sender,
          primarySenderName: lastMsg.sender_name,
          primaryResolvedIdentity: resolved,
          isMentionTrigger: false,
        });
        contextBatch = [];
      }

      // Emit the mention as its own segment at the sender's privilege
      const resolved = msg.resolvedIdentity ?? resolveIdentity(msg.sender);
      const senderPrivilege = resolveSenderPrivilege(msg, resolved);
      segments.push({
        messages: [msg],
        effectivePrivilege: senderPrivilege,
        primarySender: msg.sender,
        primarySenderName: msg.sender_name,
        primaryResolvedIdentity: resolved,
        isMentionTrigger: true,
      });
    } else {
      // Accumulate non-mention messages for batching
      contextBatch.push(msg);
    }
  }

  // Flush any trailing non-mention messages as a final batch segment
  if (contextBatch.length > 0) {
    const lastMsg = contextBatch[contextBatch.length - 1];
    const resolved = lastMsg.resolvedIdentity ?? resolveIdentity(lastMsg.sender);
    segments.push({
      messages: contextBatch,
      effectivePrivilege: sessionFloorPrivilege,
      primarySender: lastMsg.sender,
      primarySenderName: lastMsg.sender_name,
      primaryResolvedIdentity: resolved,
      isMentionTrigger: false,
    });
  }

  return { segments };
}

// --- Mode 2: Every-message (session floor) chats ---

/** Result of resolving privilege for a Mode 2 (every-message) chat. */
export interface SessionPrivilegeResult {
  /** Minimum privilege across all session participants — the effective gate. */
  effectivePrivilege: PrivilegeLevel;
  /** Last message sender — used for informational senderIdentity in ContainerInput. */
  lastSender: string;
  lastSenderName: string;
  /** Resolved identity of the last sender, or null if unmapped. */
  lastResolvedIdentity: ResolvedIdentity | null;
}

/**
 * Resolves the effective privilege for a Mode 2 (every-message) chat.
 *
 * Computes the minimum privilege across all senders in the current batch,
 * then takes the minimum of that and the stored session floor. The floor
 * can only degrade (never increase) — it resets only on explicit session reset.
 *
 * @param messages - New messages in this batch.
 * @param groupFolder - Group folder identifier (used as DB key for the floor).
 * @returns The effective privilege and last sender info.
 */
export function resolveSessionPrivilege(
  messages: NewMessage[],
  groupFolder: string,
): SessionPrivilegeResult {
  // Read the current floor from DB (defaults to 'owner' if not set)
  const storedFloor = getRouterState(`privilege_floor:${groupFolder}`) as PrivilegeLevel | null;
  let currentFloor: PrivilegeLevel = storedFloor ?? 'owner';

  // Resolve all unique senders in the batch and compute min privilege
  const seenSenders = new Set<string>();
  for (const msg of messages) {
    if (seenSenders.has(msg.sender)) continue;
    seenSenders.add(msg.sender);

    const resolved = msg.resolvedIdentity ?? resolveIdentity(msg.sender);
    const senderPrivilege = resolveSenderPrivilege(msg, resolved);
    currentFloor = minPrivilege(currentFloor, senderPrivilege);
  }

  const lastMsg = messages[messages.length - 1];
  const lastResolved = lastMsg.resolvedIdentity ?? resolveIdentity(lastMsg.sender);

  return {
    effectivePrivilege: currentFloor,
    lastSender: lastMsg.sender,
    lastSenderName: lastMsg.sender_name,
    lastResolvedIdentity: lastResolved,
  };
}

/**
 * Returns the current session privilege floor for a group, updating it
 * with any new senders from the provided messages.
 *
 * This is a convenience wrapper for Mode 1 chats that need the floor
 * for non-mention batch segments without the full SessionPrivilegeResult.
 *
 * @param groupFolder - Group folder identifier.
 * @param messages - Current message batch (used to update the floor).
 * @returns The current (possibly updated) floor privilege level.
 */
export function getSessionFloorPrivilege(
  groupFolder: string,
  messages: NewMessage[],
): PrivilegeLevel {
  const storedFloor = getRouterState(`privilege_floor:${groupFolder}`) as PrivilegeLevel | null;
  let currentFloor: PrivilegeLevel = storedFloor ?? 'owner';

  const seenSenders = new Set<string>();
  for (const msg of messages) {
    if (seenSenders.has(msg.sender)) continue;
    seenSenders.add(msg.sender);

    const resolved = msg.resolvedIdentity ?? resolveIdentity(msg.sender);
    const senderPrivilege = resolveSenderPrivilege(msg, resolved);
    currentFloor = minPrivilege(currentFloor, senderPrivilege);
  }

  return currentFloor;
}

/**
 * Persists the session privilege floor for a group if it has changed.
 *
 * @param groupFolder - Group folder identifier.
 * @param floor - The computed floor privilege to persist.
 */
export function persistSessionFloor(
  groupFolder: string,
  floor: PrivilegeLevel,
): void {
  const storedFloor = getRouterState(`privilege_floor:${groupFolder}`) as PrivilegeLevel | null;
  if (floor !== storedFloor) {
    setRouterState(`privilege_floor:${groupFolder}`, floor);
  }
}

// --- Helpers ---

/**
 * Resolves the privilege level for a single sender.
 *
 * Priority:
 * 1. `is_from_me` → always 'owner' (the bot's own messages represent the owner)
 * 2. Resolved identity → use the person's stored privilege level
 * 3. Unmapped sender → 'external' (principle of least privilege)
 *
 * @param msg - The message to resolve privilege for.
 * @param resolved - Pre-resolved identity, or null if unmapped.
 * @returns The sender's privilege level.
 */
function resolveSenderPrivilege(
  msg: NewMessage,
  resolved: ResolvedIdentity | null,
): PrivilegeLevel {
  if (msg.is_from_me) return 'owner';
  return resolved?.person.privilege ?? 'external';
}
