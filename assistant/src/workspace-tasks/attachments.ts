/**
 * Getting a file out of the sandbox and onto the card.
 *
 * A file in the sandbox is not a deliverable — nobody outside the pod can open
 * it — so the task tools upload it to the workspace as a task attachment. The
 * boundary is enforced here, before any byte leaves: the path is resolved
 * against the workspace directory the other file tools use, symlinks are
 * followed with `realpath`, and anything that lands outside is refused.
 *
 * The check and the read are not two steps on a path. A path checked and then
 * opened is a path somebody can swap for a symlink in between (the model has a
 * shell), so the file is opened once, without following a final symlink, and
 * everything after — type, size, containment, the bytes themselves — is
 * decided from that descriptor.
 */

import {
  constants,
  readlinkSync,
  realpathSync,
  type Stats,
  statSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";

import {
  isDeniedBasename,
  isProcessEnvironPath,
  sandboxPolicy,
} from "../tools/shared/filesystem/path-policy.js";
import { getWorkspaceDir } from "../util/platform.js";
import type { ActiveTask } from "./active-task.js";
import {
  MAX_ATTACHMENT_BYTES,
  type UploadedTaskAttachment,
  uploadTaskAttachment,
} from "./client.js";

/** What an upload came to: the attachment, or a sentence for the model. */
export type UploadOutcome =
  | { ok: true; attachment: UploadedTaskAttachment; reused?: boolean }
  | { ok: false; error: string };

/** A file read from a vetted descriptor. */
export interface Deliverable {
  bytes: Buffer<ArrayBuffer>;
  realPath: string;
  fileName: string;
  /** dev, inode, size and mtime: what "the same file" means for dedupe. */
  identity: string;
}

/** Test seams. Production passes none. */
export interface DeliverableHooks {
  /** Runs after the path is vetted and before it is opened. */
  afterCheck?: () => void;
  /**
   * Refuse a file last modified before this time (ms since epoch, less
   * {@link CLOCK_SLACK_MS}): what the `attachments` field of submit_task and
   * report_task_progress passes, so it uploads only work done in this claim.
   */
  modifiedSinceMs?: number;
}

/** Tolerance for clock and filesystem timestamp granularity. */
const CLOCK_SLACK_MS = 2_000;

function isInside(boundary: string, target: string): boolean {
  const rel = relative(boundary, target);
  return (
    rel !== "" && !rel.startsWith("..") && resolve(boundary, rel) === target
  );
}

/**
 * The path a descriptor really names, where the platform can say. Linux
 * exposes it at `/proc/self/fd/N`; elsewhere this is null and the caller
 * falls back to comparing the file's identity with what was checked.
 */
function pathOfDescriptor(fd: number): string | null {
  try {
    return readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return null;
  }
}

/**
 * Vet a sandbox path and read the file, or say why it may not be sent.
 */
export async function readDeliverable(
  rawPath: string,
  workingDir: string = getWorkspaceDir(),
  hooks?: DeliverableHooks,
): Promise<{ ok: true; file: Deliverable } | { ok: false; error: string }> {
  const check = sandboxPolicy(rawPath, workingDir, { mustExist: true });
  if (!check.ok) {
    return {
      ok: false,
      error: `${rawPath} cannot be attached: ${check.error}. Only files inside your workspace can be attached.`,
    };
  }
  let realResolved: string;
  let realBoundary: string;
  let checked: Stats;
  try {
    realResolved = realpathSync(check.resolved);
    realBoundary = realpathSync(workingDir);
    checked = statSync(realResolved);
  } catch {
    return { ok: false, error: `${rawPath} does not exist.` };
  }
  if (!isInside(realBoundary, realResolved)) {
    return {
      ok: false,
      error: `${rawPath} cannot be attached: it resolves outside your workspace. Only files inside your workspace can be attached.`,
    };
  }
  if (checked.isDirectory()) {
    return {
      ok: false,
      error: `${rawPath} is a directory, not a file. Attach files one at a time (zip a directory first if it is one deliverable).`,
    };
  }
  hooks?.afterCheck?.();

  // O_NOFOLLOW: if the last component was swapped for a symlink after the
  // check, this fails rather than following it. O_NONBLOCK: opening a FIFO
  // must not hang the turn; it is refused as not a regular file below.
  let handle;
  try {
    handle = await open(
      realResolved,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      error:
        code === "ELOOP"
          ? `${rawPath} changed while it was being attached (it became a link). Nothing was sent.`
          : `${rawPath} could not be opened${code ? ` (${code})` : ""}.`,
    };
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return {
        ok: false,
        error: `${rawPath} is not a regular file, so it cannot be attached.`,
      };
    }
    if (
      hooks?.modifiedSinceMs !== undefined &&
      stats.mtimeMs < hooks.modifiedSinceMs - CLOCK_SLACK_MS
    ) {
      return {
        ok: false,
        error:
          `${rawPath} was not created or changed during this task, so it cannot go in ` +
          "the attachments field. If you really mean to deliver an existing file, " +
          "use attach_task_file, which a person or approval policy can see.",
      };
    }
    if (stats.size === 0) {
      return {
        ok: false,
        error: `${rawPath} is empty; there is nothing to attach.`,
      };
    }
    if (stats.size > MAX_ATTACHMENT_BYTES) {
      return {
        ok: false,
        error: `${rawPath} is ${(stats.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
      };
    }
    // The descriptor must still be the file that was checked, and still be
    // inside the boundary: a swapped directory component higher up is not
    // caught by O_NOFOLLOW.
    const actual = pathOfDescriptor(handle.fd);
    if (actual !== null) {
      if (
        !isInside(realBoundary, actual) ||
        isDeniedBasename(actual) ||
        isProcessEnvironPath(actual)
      ) {
        return {
          ok: false,
          error: `${rawPath} changed while it was being attached. Nothing was sent.`,
        };
      }
    } else if (stats.dev !== checked.dev || stats.ino !== checked.ino) {
      return {
        ok: false,
        error: `${rawPath} changed while it was being attached. Nothing was sent.`,
      };
    }

    // Read at most one byte past the limit: enough to know it grew.
    const limit = MAX_ATTACHMENT_BYTES + 1;
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < limit) {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, limit - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > MAX_ATTACHMENT_BYTES) {
      return {
        ok: false,
        error: `${rawPath} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
      };
    }
    if (total === 0) {
      return {
        ok: false,
        error: `${rawPath} is empty; there is nothing to attach.`,
      };
    }
    return {
      ok: true,
      file: {
        bytes: Buffer.concat(chunks, total),
        realPath: actual ?? realResolved,
        fileName: basename(realResolved),
        identity: `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`,
      },
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Vet, upload and record one file against the active claim. */
export async function attachFile(
  active: ActiveTask,
  rawPath: string,
  note: string | undefined,
  workingDir?: string,
  hooks?: DeliverableHooks,
): Promise<UploadOutcome> {
  const read = await readDeliverable(rawPath, workingDir, hooks);
  if (!read.ok) {
    return read;
  }
  const { file } = read;
  // The same file, unchanged, is one attachment however many times it is
  // named: a retry after a partial failure must not upload the rest twice.
  const known = active.uploadsByIdentity?.get(file.identity);
  if (known) {
    return { ok: true, attachment: known, reused: true };
  }
  const result = await uploadTaskAttachment(
    active.claim.task_id,
    file.bytes,
    file.fileName,
    note,
  );
  if (result.outcome !== "ok") {
    return {
      ok: false,
      error:
        result.outcome === "refused"
          ? `${rawPath} could not be attached: ${result.reason}`
          : `The workspace did not answer while ${rawPath} was being attached (${result.reason}). ` +
            "The file may already be attached — check the card before attaching it again.",
    };
  }
  (active.uploadsByIdentity ??= new Map()).set(file.identity, result.value);
  (active.uploads ??= []).push({
    id: result.value.id,
    fileName: result.value.file_name,
    realPath: file.realPath,
  });
  return { ok: true, attachment: result.value };
}

/**
 * Upload several files, stopping at the first that fails so the caller can
 * report it before anything is submitted. The error names what did go up, so
 * the model retries only the rest.
 */
export async function attachFiles(
  active: ActiveTask,
  paths: string[],
  workingDir?: string,
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  const ids: string[] = [];
  const done: string[] = [];
  for (const path of paths) {
    // Inline attachments only carry this claim's own work; an older file
    // goes through attach_task_file, which is gated by its risk level.
    const outcome = await attachFile(active, path, undefined, workingDir, {
      modifiedSinceMs:
        active.startedAt ?? (Date.parse(active.claim.claimed_at) || undefined),
    });
    if (!outcome.ok) {
      const remaining = paths.slice(paths.indexOf(path));
      return {
        ok: false,
        error:
          outcome.error +
          (done.length
            ? ` Already attached and not to be sent again: ${done.join(", ")}. ` +
              `Retry only: ${remaining.join(", ")}.`
            : ""),
      };
    }
    ids.push(outcome.attachment.id);
    done.push(`${outcome.attachment.file_name} (${outcome.attachment.id})`);
  }
  return { ok: true, ids };
}

const DELIVERABLE_EXTENSIONS =
  "md|csv|tsv|json|pdf|txt|html|xlsx|xls|docx|pptx|png|jpg|jpeg|svg|zip";
const FILE_MENTION = new RegExp(
  `[\\p{L}\\p{N}_@%+~/.-]+\\.(?:${DELIVERABLE_EXTENSIONS})(?![\\p{L}\\p{N}_])`,
  "giu",
);
const URL_TOKEN = /https?:\/\/\S+/giu;

/**
 * Files a summary names in passing: the project's own plumbing, not
 * something anyone asked to be handed over.
 */
const NOT_A_DELIVERABLE =
  /^(?:package\.json|package-lock\.json|tsconfig[\w.-]*\.json|readme\.md|changelog\.md|license[\w.-]*|robots\.txt|[\w.-]+\.lock)$/iu;

/** Names in `text` that look like deliverable files, URLs left out. */
export function mentionedFiles(text: string): string[] {
  const names = text.replace(URL_TOKEN, " ").match(FILE_MENTION) ?? [];
  return [...new Set(names)];
}

/**
 * The files the summary names that exist in the workspace, are not project
 * plumbing, and have not been attached during this claim.
 *
 * Only files that really exist count: a name the model mentions in passing
 * ("see node.js docs") is not a missing deliverable.
 */
export function unattachedMentions(
  text: string,
  active: ActiveTask,
  workingDir: string = getWorkspaceDir(),
): string[] {
  const uploads = active.uploads ?? [];
  const realPaths = new Set(uploads.map((upload) => upload.realPath));
  const names = new Set(uploads.map((upload) => upload.fileName));
  const missing: string[] = [];
  for (const mention of mentionedFiles(text)) {
    if (NOT_A_DELIVERABLE.test(basename(mention))) {
      continue;
    }
    let real: string;
    try {
      const check = sandboxPolicy(mention, workingDir, { mustExist: true });
      if (!check.ok) {
        continue;
      }
      real = realpathSync(check.resolved);
      if (!statSync(real).isFile()) {
        continue;
      }
    } catch {
      continue;
    }
    if (!realPaths.has(real) && !names.has(basename(real))) {
      missing.push(mention);
    }
  }
  return missing;
}
