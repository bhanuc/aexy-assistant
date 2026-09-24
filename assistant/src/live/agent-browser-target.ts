/**
 * Which page the agent's browser tool is driving.
 *
 * The watch stream shows "exactly the tab the agent is on" (plan D2), and the
 * only party that knows which tab that is, is the cdp-inspect client that just
 * attached to it. It notes the target here; the screencaster follows.
 */

export interface AgentBrowserTarget {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly webSocketDebuggerUrl: string;
}

type Listener = (target: AgentBrowserTarget) => void;

let current: AgentBrowserTarget | null = null;
const listeners = new Set<Listener>();

export function noteAgentBrowserTarget(target: AgentBrowserTarget): void {
  const changed = current?.id !== target.id;
  current = {
    id: target.id,
    url: target.url,
    title: target.title,
    webSocketDebuggerUrl: target.webSocketDebuggerUrl,
  };
  if (!changed) {
    return;
  }
  for (const listener of listeners) {
    try {
      listener(current);
    } catch {
      // A watcher's bookkeeping must never fail the agent's tool call.
    }
  }
}

export function getAgentBrowserTarget(): AgentBrowserTarget | null {
  return current;
}

export function onAgentBrowserTargetChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** @internal Test helper. */
export function _resetAgentBrowserTargetForTests(): void {
  current = null;
  listeners.clear();
}
