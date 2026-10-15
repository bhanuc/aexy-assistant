/**
 * Noticing a tool that has stopped working, and saying so once.
 *
 * A pod that keeps calling a broken tool and quietly works around it leaves
 * the card with no trace of why the result is not what was asked for. After
 * three infrastructure failures in a row the runtime posts one progress note
 * naming the tool. Once per tool per claim: a note on every failure would
 * bury the feed.
 *
 * Only infrastructure failures count. A shell command that exits non-zero, a
 * grep with no match, a test run that fails are the work doing its job, not a
 * broken tool, and the model's own output must never be what gets posted: the
 * note is a fixed sentence plus, at most, a short sanitized error class.
 */

import type { ActiveTask } from "./active-task.js";

export const BROKEN_TOOL_THRESHOLD = 3;

/** Tools whose failure is the claim being gone, or the task's own plumbing. */
const EXEMPT = new Set([
  "report_task_progress",
  "submit_task",
  "release_task",
  "attach_task_file",
]);

/** Tools whose non-zero exits are ordinary results, not breakage. */
const SHELL_TOOLS = new Set([
  "bash",
  "host_bash",
  "shell",
  "sh",
  "exec",
  "terminal",
  "run_command",
  "execute_command",
]);

const NETWORK_CODES =
  /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH)\b/;
const HTTP_STATUS = /\b(?:http|status(?: code)?|error)\D{0,4}([45]\d\d)\b/i;
const BARE_STATUS =
  /\b([45]\d\d) (?:Not Found|Forbidden|Unauthorized|Bad Gateway|Service Unavailable|Gateway Timeout|Too Many Requests|Internal Server Error)\b/i;
const OTHER_MARKERS =
  /\b(timed? ?out|timeout|socket hang up|fetch failed|network error|rate.?limit(?:ed)?|too many requests|provider error|upstream|service unavailable|bad gateway)\b/i;

/**
 * What kind of infrastructure failure this was, as a short safe token, or
 * null when it is not one.
 */
function infrastructureClass(
  errorCode: string | undefined,
  result: string,
): string | null {
  if (errorCode) {
    return errorCode.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40) || "error";
  }
  const code = NETWORK_CODES.exec(result);
  if (code) {
    return code[1];
  }
  const status = HTTP_STATUS.exec(result) ?? BARE_STATUS.exec(result);
  if (status) {
    return `HTTP ${status[1]}`;
  }
  if (OTHER_MARKERS.test(result)) {
    return /rate.?limit|too many/i.test(result) ? "rate limited" : "timeout";
  }
  return null;
}

/** Escape what Markdown would otherwise interpret. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]()#<>~|]/g, "\\$&");
}

/**
 * Feed one tool result in. Returns the tool and note to post when this result
 * is the third consecutive infrastructure failure of its tool, otherwise null.
 *
 * The tool is marked noted on return; call {@link releaseBrokenToolNote} if
 * the post did not land, so the next failure tries again.
 */
export function observeToolResult(
  active: ActiveTask,
  toolName: string,
  isError: boolean,
  result: string,
  errorCode?: string,
): { tool: string; note: string } | null {
  if (active.settled || EXEMPT.has(toolName) || SHELL_TOOLS.has(toolName)) {
    return null;
  }
  const failures = (active.toolFailures ??= new Map<string, number>());
  if (!isError) {
    failures.delete(toolName);
    return null;
  }
  const failure = infrastructureClass(errorCode, result);
  if (failure === null) {
    return null;
  }
  const count = (failures.get(toolName) ?? 0) + 1;
  failures.set(toolName, count);
  const noted = (active.brokenToolsNoted ??= new Set<string>());
  if (count < BROKEN_TOOL_THRESHOLD || noted.has(toolName)) {
    return null;
  }
  noted.add(toolName);
  const safeName = /^[A-Za-z0-9_.-]{1,60}$/.test(toolName)
    ? toolName
    : "a tool";
  return {
    tool: toolName,
    note: `${escapeMarkdown(safeName)} keeps failing (${escapeMarkdown(failure)}); working around it.`,
  };
}

/** Allow the next failure of `toolName` to try posting its note again. */
export function releaseBrokenToolNote(
  active: ActiveTask,
  toolName: string,
): void {
  active.brokenToolsNoted?.delete(toolName);
}
