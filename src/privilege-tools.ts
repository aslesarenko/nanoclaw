/**
 * Privilege-to-Tool Mapping for NanoClaw (Extension C)
 *
 * Maps privilege levels to allowed tool sets for Claude Agent SDK invocations.
 * This is the code-level enforcement of the per-sender access control model:
 * the agent literally receives different tool lists depending on the sender's
 * privilege, so there is no way for it to call tools beyond its level.
 *
 * Design decisions:
 * - Owner: Full tool set including Gmail MCP (email access).
 * - Colleague: Everything except Gmail — colleagues should not access the owner's email.
 * - External: Read-only subset — no file writes, no task orchestration, no agent teams,
 *   no email. Retains Bash (sandboxed inside container), read tools, and web access
 *   for useful read-only interaction.
 *
 * Returns copies of arrays to prevent callers from mutating the canonical lists.
 */
import { PrivilegeLevel } from './types.js';

/**
 * Full tool set for owner privilege — matches the hardcoded list in agent-runner.
 * Any changes here must be reflected in the fallback list in
 * container/agent-runner/src/index.ts.
 */
const OWNER_TOOLS: readonly string[] = [
  'Bash',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
  'mcp__gmail__*',
];

/**
 * Colleague tool set — same as owner minus Gmail MCP.
 * Colleagues should not have access to the owner's email account.
 */
const COLLEAGUE_TOOLS: readonly string[] = OWNER_TOOLS.filter(
  (t) => !t.startsWith('mcp__gmail'),
);

/**
 * External tool set — read-only interaction subset.
 *
 * Excluded tools and rationale:
 * - Write, Edit, NotebookEdit: No file modification — external users should not
 *   alter the agent's workspace or group files.
 * - Task, TaskOutput, TaskStop: No background task orchestration — external users
 *   should not schedule or manage long-running work.
 * - TeamCreate, TeamDelete, SendMessage: No agent team orchestration — external users
 *   should not spawn sub-agents or send messages to other groups.
 * - mcp__gmail__*: No email access — same restriction as colleague, plus external
 *   users should never access organizational email.
 *
 * Retained tools:
 * - Bash: Sandboxed inside the container — useful for command execution within the
 *   container's isolated filesystem.
 * - Read, Glob, Grep: Read-only file access within mounted directories.
 * - WebSearch, WebFetch: Public web access for answering questions.
 * - TodoWrite, ToolSearch, Skill: Agent-internal tools for planning and discovery.
 * - mcp__nanoclaw__*: IPC tools for sending responses back to the host.
 */
const EXTERNAL_TOOLS: readonly string[] = [
  'Bash',
  'Read', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'TodoWrite', 'ToolSearch', 'Skill',
  'mcp__nanoclaw__*',
];

/**
 * Returns the list of allowed tools for a given privilege level.
 *
 * This is the primary security gate for tool access: the returned list is passed
 * directly to the Claude Agent SDK's `allowedTools` option in `query()`, which
 * prevents the agent from invoking any tool not in the list.
 *
 * @param privilege - The effective privilege level for the invocation.
 * @returns A new array of tool name patterns. Returns a copy so callers
 *          cannot mutate the canonical lists.
 */
export function getAllowedToolsForPrivilege(privilege: PrivilegeLevel): string[] {
  switch (privilege) {
    case 'owner':
      return [...OWNER_TOOLS];
    case 'colleague':
      return [...COLLEAGUE_TOOLS];
    case 'external':
      return [...EXTERNAL_TOOLS];
  }
}
