import type { Archive } from './archive.js';
import type { Policy } from './policy.js';
import { itemText } from './types.js';

/**
 * Repeat-call recall. If the model calls a tool with the same name and
 * identical arguments as an archived, non-error result, the harness can answer
 * from the archive instead of executing again.
 *
 * Opt-in via `policy.resurface.repeatToolCalls`, and never for tools in
 * `policy.toolResults.volatile`. The default policy leaves it off: a coding
 * agent that re-reads a file after editing it must see the new content.
 * Turn it on for tools whose output is a pure function of their arguments.
 */
export interface Served {
  archiveId: string;
  turn: number;
  text: string;
}

export function serveFromArchive(archive: Archive, policy: Policy, tool: string, args: unknown): Served | undefined {
  if (!policy.resurface.repeatToolCalls) return undefined;
  if (policy.toolResults.volatile.includes(tool)) return undefined;
  const hit = archive.findToolResult(tool, args);
  if (!hit || hit.kind !== 'tool_result') return undefined;
  return {
    archiveId: hit.id,
    turn: hit.turn,
    text: `[windowkeeper] identical ${tool} call at turn ${hit.turn}; served from archive ${hit.id}\n${itemText(hit)}`,
  };
}
