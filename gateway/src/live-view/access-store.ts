/**
 * Who besides the guardian may talk to this assistant, and whose each
 * conversation is (contract C6, plan WS-12).
 *
 * Aexy owns the answer to the first question and pushes the whole list on
 * every change (`PUT /v1/live/access-list`); the gateway only keeps the last
 * one it was given. The second is the gateway's own record: when someone on
 * the list starts a conversation through `/v1/live/chat/messages`, the
 * conversation is theirs, and nobody else on the list may post to it or
 * stream it, except an owner, manager or admin reading it through the
 * threads index. A conversation with no record is the guardian's.
 *
 * Both live in one file in the gateway security directory, next to the
 * feature-flag and trust stores and with the same discipline: atomic write
 * (temp file + rename), 0600, cached in memory and re-read before a write so
 * one update cannot erase another. The daemon cannot read that directory, so
 * a prompt-injected agent cannot put itself on its own access list.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { getLogger } from "../logger.js";
import { getGatewaySecurityDir } from "../paths.js";
import { VIEWER_ROLES, type ViewerRole } from "./roles.js";

const log = getLogger("live-access-store");

export interface AccessEntry {
  /** Platform `users.id`: what the orchestrator and tunnel attest. */
  platformUserId: string;
  aexyDeveloperId: string;
  displayName: string;
  role: ViewerRole;
  canChat: boolean;
}

export interface ConversationOwner {
  platformUserId: string;
  aexyDeveloperId: string;
}

interface LiveAccessFile {
  version: 1;
  entries: AccessEntry[];
  conversations: Record<string, ConversationOwner>;
  updatedAt: string | null;
}

const EMPTY: LiveAccessFile = {
  version: 1,
  entries: [],
  conversations: {},
  updatedAt: null,
};

export function getLiveAccessStorePath(): string {
  return join(getGatewaySecurityDir(), "aexy-live-access.json");
}

let cached: LiveAccessFile | null = null;

function isEntry(value: unknown): value is AccessEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.platformUserId === "string" &&
    typeof e.aexyDeveloperId === "string" &&
    typeof e.displayName === "string" &&
    typeof e.canChat === "boolean" &&
    (VIEWER_ROLES as readonly unknown[]).includes(e.role)
  );
}

function isOwner(value: unknown): value is ConversationOwner {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.platformUserId === "string" &&
    typeof o.aexyDeveloperId === "string"
  );
}

/**
 * The stored state. A file that cannot be read or parsed reads as empty, so a
 * damaged store fails closed: nobody but the guardian gets in until Aexy
 * pushes the list again.
 */
function readState(): LiveAccessFile {
  if (cached) return cached;
  const path = getLiveAccessStorePath();
  if (!existsSync(path)) {
    cached = { ...EMPTY, entries: [], conversations: {} };
    return cached;
  }
  try {
    const data = JSON.parse(
      readFileSync(path, "utf-8"),
    ) as Partial<LiveAccessFile>;
    if (data.version !== 1) {
      log.warn({ version: data.version }, "Unknown live access store version");
      cached = { ...EMPTY, entries: [], conversations: {} };
      return cached;
    }
    const conversations: Record<string, ConversationOwner> = {};
    for (const [id, owner] of Object.entries(data.conversations ?? {})) {
      if (isOwner(owner)) conversations[id] = owner;
    }
    cached = {
      version: 1,
      entries: Array.isArray(data.entries) ? data.entries.filter(isEntry) : [],
      conversations,
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
    };
    return cached;
  } catch (err) {
    log.error({ err }, "Failed to load live access store");
    cached = { ...EMPTY, entries: [], conversations: {} };
    return cached;
  }
}

function writeState(state: LiveAccessFile): void {
  const path = getLiveAccessStorePath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${path}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmpPath, path);
  chmodSync(path, 0o600);
  cached = state;
}

/** Replace the whole access list, as C6 says Aexy always sends it. */
export function replaceAccessEntries(entries: AccessEntry[]): void {
  cached = null;
  const state = readState();
  writeState({
    ...state,
    entries,
    updatedAt: new Date().toISOString(),
  });
  log.info({ count: entries.length }, "Replaced live access list");
}

export function listAccessEntries(): readonly AccessEntry[] {
  return readState().entries;
}

/** The entry for an attested platform user, if they are on the list. */
export function findAccessEntry(
  platformUserId: string,
): AccessEntry | undefined {
  return readState().entries.find((e) => e.platformUserId === platformUserId);
}

/** Whose a conversation is; undefined means the guardian's. */
export function conversationOwner(
  conversationId: string,
): ConversationOwner | undefined {
  const { conversations } = readState();
  return Object.hasOwn(conversations, conversationId)
    ? conversations[conversationId]
    : undefined;
}

/** Record that `owner` started `conversationId`. First writer keeps it. */
export function recordConversationOwner(
  conversationId: string,
  owner: ConversationOwner,
): void {
  cached = null;
  const state = readState();
  if (Object.hasOwn(state.conversations, conversationId)) return;
  writeState({
    ...state,
    conversations: { ...state.conversations, [conversationId]: owner },
  });
}

/** Drop the in-memory copy so the next read goes to disk. For tests. */
export function clearLiveAccessStoreCache(): void {
  cached = null;
}
