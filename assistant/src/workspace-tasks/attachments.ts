/**
 * Getting a file out of the sandbox and onto the card.
 *
 * A file in the sandbox is not a deliverable — nobody outside the pod can open
 * it — so the task tools upload it to the workspace as a task attachment. The
 * boundary is enforced here, before any byte is read: the path is resolved
 * against the workspace directory the other file tools use, symlinks are
 * followed with `realpath`, and anything that lands outside is refused.
 */

import { statSync } from "node:fs";

import { sandboxPolicy } from "../tools/shared/filesystem/path-policy.js";
import { getWorkspaceDir } from "../util/platform.js";
import type { ActiveTask } from "./active-task.js";
import {
  MAX_ATTACHMENT_BYTES,
  type UploadedTaskAttachment,
  uploadTaskAttachment,
} from "./client.js";

/** What an upload came to: the attachment, or a sentence for the model. */
export type UploadOutcome =
  | { ok: true; attachment: UploadedTaskAttachment }
  | { ok: false; error: string };

/**
 * Vet a sandbox path. Returns the resolved absolute path, or the reason it
 * may not be sent.
 */
export function resolveDeliverable(
  rawPath: string,
  workingDir: string = getWorkspaceDir(),
): { ok: true; path: string } | { ok: false; error: string } {
  const check = sandboxPolicy(rawPath, workingDir, { mustExist: true });
  if (!check.ok) {
    return {
      ok: false,
      error: `${rawPath} cannot be attached: ${check.error}. Only files inside your workspace can be attached.`,
    };
  }
  let stats;
  try {
    stats = statSync(check.resolved);
  } catch {
    return { ok: false, error: `${rawPath} does not exist.` };
  }
  if (!stats.isFile()) {
    return {
      ok: false,
      error: `${rawPath} is a directory, not a file. Attach files one at a time (zip a directory first if it is one deliverable).`,
    };
  }
  if (stats.size > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: `${rawPath} is ${(stats.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
    };
  }
  return { ok: true, path: check.resolved };
}

/** Vet, upload and record one file against the active claim. */
export async function attachFile(
  active: ActiveTask,
  rawPath: string,
  note: string | undefined,
  workingDir?: string,
): Promise<UploadOutcome> {
  const vetted = resolveDeliverable(rawPath, workingDir);
  if (!vetted.ok) {
    return vetted;
  }
  const result = await uploadTaskAttachment(
    active.claim.task_id,
    vetted.path,
    note,
  );
  if (result.outcome !== "ok") {
    return {
      ok: false,
      error:
        result.outcome === "refused"
          ? `${rawPath} could not be attached: ${result.reason}`
          : `The workspace could not be reached: ${result.reason}`,
    };
  }
  (active.uploads ??= []).push({
    id: result.value.id,
    fileName: result.value.file_name,
  });
  return { ok: true, attachment: result.value };
}

/**
 * Upload several files, stopping at the first that fails so the caller can
 * report it before anything is submitted.
 */
export async function attachFiles(
  active: ActiveTask,
  paths: string[],
  workingDir?: string,
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  const ids: string[] = [];
  for (const path of paths) {
    const outcome = await attachFile(active, path, undefined, workingDir);
    if (!outcome.ok) {
      return outcome;
    }
    ids.push(outcome.attachment.id);
  }
  return { ok: true, ids };
}

const DELIVERABLE_EXTENSIONS =
  "md|csv|json|pdf|txt|html|xlsx|docx|png|jpg|svg|zip";
const FILE_MENTION = new RegExp(
  `[\\w@%+~/.-]+\\.(?:${DELIVERABLE_EXTENSIONS})(?![\\w])`,
  "i",
);

/** The first thing in `text` that looks like a deliverable file name. */
export function mentionedFile(text: string): string | null {
  return FILE_MENTION.exec(text)?.[0] ?? null;
}
