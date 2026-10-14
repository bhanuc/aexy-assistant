/**
 * Noticing a tool that has stopped working, and saying so once.
 *
 * A pod that keeps calling a broken tool and quietly works around it leaves
 * the card with no trace of why the result is not what was asked for. After
 * three failures in a row the runtime posts one progress note naming the tool.
 * Once per tool per claim: a note on every failure would bury the feed.
 */

import type { ActiveTask } from "./active-task.js";

export const BROKEN_TOOL_THRESHOLD = 3;

/** Tools whose failure is the claim being gone, not a broken tool. */
const EXEMPT = new Set(["report_task_progress", "submit_task", "release_task"]);

/**
 * Feed one tool result in. Returns the note to post when this result is the
 * third consecutive failure of its tool, otherwise null.
 */
export function observeToolResult(
  active: ActiveTask,
  toolName: string,
  isError: boolean,
  result: string,
): string | null {
  if (EXEMPT.has(toolName)) {
    return null;
  }
  const failures = (active.toolFailures ??= new Map<string, number>());
  if (!isError) {
    failures.delete(toolName);
    return null;
  }
  const count = (failures.get(toolName) ?? 0) + 1;
  failures.set(toolName, count);
  const noted = (active.brokenToolsNoted ??= new Set<string>());
  if (count < BROKEN_TOOL_THRESHOLD || noted.has(toolName)) {
    return null;
  }
  noted.add(toolName);
  const firstLine =
    result
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "no error text";
  return `${toolName} is failing (${firstLine.slice(0, 200)}); working around it.`;
}
