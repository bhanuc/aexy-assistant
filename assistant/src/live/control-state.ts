/**
 * The live-control state every live surface reads: whether the agent is
 * paused and by whom, who holds the control lease, and any open takeover the
 * agent asked for. Written only by `live-control.ts`; read by the watch hub
 * for `hello` and `control_state`, and by the tool and loop gates.
 *
 * Kept free of daemon imports so the gates in the agent loop and the tool
 * executor can read it without pulling the conversation machinery in.
 */

/** A person, as Aexy names them: `aexy_developer_id` and a display name. */
export interface LivePerson {
  readonly id: string;
  readonly name: string;
}

export interface LiveTakeover {
  readonly id: string;
  readonly reason: string;
}

export interface LiveControlSnapshot {
  readonly paused: boolean;
  readonly pausedBy: LivePerson | null;
  readonly holder: LivePerson | null;
  readonly takeover: LiveTakeover | null;
  /** The conversation a pause or lease applies to; `null` for any. */
  readonly conversationId: string | null;
}

type Listener = (snapshot: LiveControlSnapshot) => void;

const IDLE: LiveControlSnapshot = {
  paused: false,
  pausedBy: null,
  holder: null,
  takeover: null,
  conversationId: null,
};

let snapshot: LiveControlSnapshot = IDLE;
const listeners = new Set<Listener>();

export function getLiveControlSnapshot(): LiveControlSnapshot {
  return snapshot;
}

/** Replace the state and tell every listener. */
export function setLiveControlSnapshot(
  next: Partial<LiveControlSnapshot>,
): LiveControlSnapshot {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {
      // A broken watcher must not stop the agent being paused or resumed.
    }
  }
  return snapshot;
}

export function onLiveControlChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether a pause or lease covers `conversationId`. */
export function controlAppliesTo(conversationId: string | undefined): boolean {
  return (
    snapshot.conversationId === null ||
    conversationId === undefined ||
    snapshot.conversationId === conversationId
  );
}

/** @internal Test helper. */
export function _resetLiveControlStateForTests(): void {
  snapshot = IDLE;
  listeners.clear();
}
