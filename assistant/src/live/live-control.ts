/**
 * `POST /v1/live/control` (contract C4.2): the ways a person intervenes in a
 * running agent — pause, resume, instruct, stop, take control, hand it back.
 *
 * Every command arrives through Aexy, which has already checked the person may
 * do it and written it to the intervention log (C4.1), then through the
 * platform and the gateway. So this side does not decide *whether*; it only
 * does the thing, and says what the state is now.
 *
 * **Pausing happens at step boundaries.** A running tool call is never cut
 * off: the agent loop asks {@link LiveControl.waitWhilePaused} before each model
 * call and before each batch of tools, so the step in flight finishes and the
 * next one waits.
 *
 * **Taking control is a lease.** `acquire_control` pauses the agent and
 * gives one person the desktop; while it is held the browser and computer-use
 * tools refuse ("A person is driving the browser") and only that person may
 * open `/v1/desktop/stream` (C3). Closing the desktop socket does not end the
 * lease — a dropped connection is not a hand-back — but 120 s with it closed
 * does, as does `release_control`.
 *
 * **Handing back is not proof.** The agent is told who handed back, how and
 * with what note, and given a fresh screenshot, and must look at the page
 * itself before believing anything was done (plan D5).
 */

import { getLogger } from "../util/logger.js";
import {
  controlAppliesTo,
  getLiveControlSnapshot,
  type LiveControlSnapshot,
  type LivePerson,
  setLiveControlSnapshot,
} from "./control-state.js";

const log = getLogger("live-control");

/** How long a lease survives with nobody on the desktop socket (C3). */
export const CONTROL_LEASE_IDLE_MS = 120_000;

export const DRIVING_REFUSAL =
  "A person is driving the browser. Browser and computer-use tools are " +
  "unavailable until they hand control back; wait, or work on something " +
  "that does not need the browser.";

type Command =
  | "pause"
  | "resume"
  | "instruct"
  | "stop"
  | "acquire_control"
  | "release_control"
  | "signin_decision";

const COMMANDS: ReadonlySet<string> = new Set<Command>([
  "pause",
  "resume",
  "instruct",
  "stop",
  "acquire_control",
  "release_control",
  "signin_decision",
]);

const ROLES: ReadonlySet<string> = new Set([
  "owner",
  "manager",
  "admin",
  "member",
]);
/** Who may end somebody else's lease. */
const OVERRIDE_ROLES: ReadonlySet<string> = new Set([
  "owner",
  "manager",
  "admin",
]);

export interface LiveActor {
  readonly id: string;
  readonly name: string;
  readonly role: "owner" | "manager" | "admin" | "member";
}

/** How a takeover ended, for whoever is waiting on it. */
export interface TakeoverOutcome {
  readonly outcome: "done" | "cannot";
  readonly note: string;
  readonly by: string;
  readonly reason: "released" | "lease_expired";
}

export interface ControlResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export interface LiveControlDeps {
  /** Append a user message to a conversation, starting a turn if idle. */
  deliver(
    conversationId: string,
    text: string,
    image?: Uint8Array | null,
  ): Promise<void>;
  /** Abort the conversation's running turn; false when none was running. */
  abortTurn(conversationId: string): boolean;
  /** The claimed card, if any, and the conversation working it. */
  activeTask(): { taskId: string; conversationId?: string } | null;
  /** Give the claimed card back, having been stopped. */
  releaseActiveTask(reason: string): Promise<void>;
  /** The conversation a command without one applies to. */
  resolveTarget(): string | null;
  captureScreenshot(): Promise<Uint8Array | null>;
  leaseIdleMs?: number;
}

interface PauseWaiter {
  readonly conversationId: string | undefined;
  readonly resolve: () => void;
}

export class LiveControl {
  private pauseWaiters = new Set<PauseWaiter>();
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;
  private desktopSocketOpen = false;
  private takeoverWaiters = new Map<string, (o: TakeoverOutcome) => void>();

  constructor(private readonly deps: LiveControlDeps) {}

  get snapshot(): LiveControlSnapshot {
    return getLiveControlSnapshot();
  }

  // ── Gates the agent consults ──────────────────────────────────────

  /**
   * Resolve once the agent may take its next step. Immediate unless a pause
   * covers this conversation; an abort ends the wait so a stopped turn is not
   * held open by a pause.
   */
  waitWhilePaused(
    conversationId: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = this.snapshot;
    if (!state.paused || !controlAppliesTo(conversationId) || signal?.aborted) {
      return Promise.resolve();
    }
    log.info({ conversationId }, "Agent paused at a step boundary");
    return new Promise((resolve) => {
      const waiter: PauseWaiter = {
        conversationId,
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          this.pauseWaiters.delete(waiter);
          resolve();
        },
      };
      const onAbort = () => waiter.resolve();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pauseWaiters.add(waiter);
    });
  }

  /** The refusal for a tool the person driving would collide with, if any. */
  toolRefusal(
    toolName: string,
    conversationId: string | undefined,
  ): string | null {
    const state = this.snapshot;
    if (!state.holder || !controlAppliesTo(conversationId)) {
      return null;
    }
    if (
      toolName.startsWith("browser_") ||
      toolName.startsWith("computer_use")
    ) {
      return DRIVING_REFUSAL;
    }
    return null;
  }

  /**
   * C3: whether this person may open `/v1/desktop/stream` now. Only the
   * current lease holder; nobody while no lease is held.
   */
  mayOpenDesktop(aexyDeveloperId: string | null): boolean {
    const holder = this.snapshot.holder;
    return !!holder && !!aexyDeveloperId && holder.id === aexyDeveloperId;
  }

  /** The holder's desktop socket opened or closed. */
  noteDesktopSocket(open: boolean): void {
    this.desktopSocketOpen = open;
    if (!this.snapshot.holder) {
      return;
    }
    if (open) {
      this.clearLeaseTimer();
    } else {
      this.armLeaseTimer();
    }
  }

  /**
   * Wait for the takeover the agent asked for to end: a hand-back naming it,
   * the lease running out, or the caller's own deadline or abort (which
   * resolve `null`).
   */
  awaitTakeover(
    takeoverId: string,
    deadlineMs: number,
    signal?: AbortSignal,
  ): Promise<TakeoverOutcome | null> {
    return new Promise((resolve) => {
      const done = (outcome: TakeoverOutcome | null) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.takeoverWaiters.delete(takeoverId);
        resolve(outcome);
      };
      const onAbort = () => done(null);
      const timer = setTimeout(() => done(null), Math.max(0, deadlineMs));
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.takeoverWaiters.set(takeoverId, done);
    });
  }

  /** Put the agent's own takeover request on the control state. */
  openTakeover(takeoverId: string, reason: string): void {
    setLiveControlSnapshot({ takeover: { id: takeoverId, reason } });
  }

  /** Clear it again, when the wait ended without a hand-back. */
  closeTakeover(takeoverId: string): void {
    this.takeoverWaiters.delete(takeoverId);
    if (this.snapshot.takeover?.id === takeoverId) {
      setLiveControlSnapshot({ takeover: null });
    }
  }

  /** Stop the lease clock and release anyone waiting. For shutdown and tests. */
  dispose(): void {
    this.clearLeaseTimer();
    for (const waiter of [...this.pauseWaiters]) {
      waiter.resolve();
    }
    this.takeoverWaiters.clear();
  }

  // ── Commands ──────────────────────────────────────────────────────

  async handle(raw: unknown): Promise<ControlResponse> {
    const body = (raw ?? {}) as Record<string, unknown>;
    const command = typeof body.command === "string" ? body.command : "";
    if (!COMMANDS.has(command)) {
      return unprocessable("unknown_command", `Unknown command "${command}"`);
    }
    if (command === "signin_decision") {
      // Saving sign-ins (C7) is not built on this side.
      return {
        status: 501,
        body: {
          ok: false,
          code: "not_implemented",
          message: "Saving sign-ins is not available on this assistant",
        },
      };
    }
    const actor = parseActor(body.actor);
    if (!actor) {
      return unprocessable(
        "invalid_actor",
        "actor needs aexy_developer_id, display_name and role",
      );
    }
    const conversationId =
      typeof body.conversation_id === "string" && body.conversation_id
        ? body.conversation_id
        : null;

    switch (command as Exclude<Command, "signin_decision">) {
      case "pause":
        return this.pause(actor, conversationId);
      case "resume":
        return this.resume(actor);
      case "instruct":
        return this.instruct(actor, conversationId, body.text);
      case "stop":
        return this.stop(actor, conversationId);
      case "acquire_control":
        return this.acquire(actor, conversationId);
      case "release_control":
        return this.release(actor, body);
    }
  }

  private pause(actor: LiveActor, conversationId: string | null) {
    const target = conversationId ?? this.deps.resolveTarget();
    if (!this.snapshot.paused) {
      setLiveControlSnapshot({
        paused: true,
        pausedBy: person(actor),
        conversationId: target,
      });
    }
    return this.ok();
  }

  private resume(actor: LiveActor) {
    const holder = this.snapshot.holder;
    if (holder) {
      // The agent must not act while someone is on the desktop; they end the
      // lease with release_control, which resumes.
      return conflict("control_held", { holder });
    }
    this.setPaused(false);
    log.info({ by: actor.id }, "Agent resumed");
    return this.ok();
  }

  private async instruct(
    actor: LiveActor,
    conversationId: string | null,
    text: unknown,
  ) {
    if (typeof text !== "string" || !text.trim()) {
      return unprocessable("invalid_text", "instruct needs non-empty text");
    }
    const target =
      conversationId ??
      this.snapshot.conversationId ??
      this.deps.activeTask()?.conversationId ??
      this.deps.resolveTarget();
    if (!target) {
      return conflict("no_active_run", {});
    }
    // Queued, not steered: a turn in flight gets it at its next step
    // boundary, and an idle conversation starts a turn on it. Never dropped.
    await this.deps.deliver(
      target,
      `Instruction from ${actor.name} (${actor.role}): ${text.trim()}`,
    );
    return this.ok(target);
  }

  private async stop(actor: LiveActor, conversationId: string | null) {
    const task = this.deps.activeTask();
    const target =
      conversationId ??
      task?.conversationId ??
      this.snapshot.conversationId ??
      this.deps.resolveTarget();
    if (!target && !task) {
      return conflict("no_active_run", {});
    }
    // A pause or lease must not keep a stopped turn alive or strand the next.
    this.endLease();
    this.setPaused(false);
    if (task && (!conversationId || task.conversationId === conversationId)) {
      // Before the abort, so the runner sees the card settled and does not
      // return it again as "decided nothing".
      await this.deps.releaseActiveTask(`Stopped by ${actor.name}`);
    }
    const aborted = target ? this.deps.abortTurn(target) : false;
    if (!aborted && !task) {
      return conflict("no_active_run", {});
    }
    log.info({ by: actor.id, conversationId: target }, "Agent stopped");
    return this.ok(target);
  }

  private acquire(actor: LiveActor, conversationId: string | null) {
    const holder = this.snapshot.holder;
    if (holder && holder.id !== actor.id) {
      return conflict("control_held", { holder });
    }
    const target =
      conversationId ??
      this.snapshot.conversationId ??
      this.deps.resolveTarget();
    setLiveControlSnapshot({
      paused: true,
      pausedBy: this.snapshot.paused ? this.snapshot.pausedBy : person(actor),
      holder: person(actor),
      conversationId: target,
    });
    if (!this.desktopSocketOpen) {
      this.armLeaseTimer();
    }
    log.info({ holder: actor.id }, "Control lease granted");
    return this.ok();
  }

  private async release(actor: LiveActor, body: Record<string, unknown>) {
    const holder = this.snapshot.holder;
    if (holder && holder.id !== actor.id && !OVERRIDE_ROLES.has(actor.role)) {
      return conflict("control_held", { holder });
    }
    const outcome = body.outcome === "cannot" ? "cannot" : "done";
    const note = typeof body.note === "string" ? body.note.trim() : "";
    const takeoverId =
      typeof body.takeover_id === "string" && body.takeover_id
        ? body.takeover_id
        : (this.snapshot.takeover?.id ?? null);
    if (holder) {
      await this.handBack(actor.name, outcome, note, takeoverId, "released");
    }
    return { ...this.ok(), body: { ...this.ok().body, signinCandidates: [] } };
  }

  // ── Internals ─────────────────────────────────────────────────────

  /**
   * End the lease, resume, tell the agent, and wake a takeover waiting on
   * it. The message is delivered before the agent resumes so it is the first
   * thing the next step sees.
   */
  private async handBack(
    name: string,
    outcome: "done" | "cannot",
    note: string,
    takeoverId: string | null,
    reason: TakeoverOutcome["reason"],
  ): Promise<void> {
    const target = this.snapshot.conversationId ?? this.deps.resolveTarget();
    this.endLease();
    const waiter = takeoverId ? this.takeoverWaiters.get(takeoverId) : null;
    if (waiter) {
      // The agent asked for this takeover and is waiting inside its tool
      // call; the tool result carries the hand-back, so no message is queued.
      waiter({ outcome, note, by: name, reason });
    } else if (target) {
      const shot = await this.deps.captureScreenshot().catch(() => null);
      const text =
        `${name} handed back control (${outcome})` +
        (note ? `: ${note}` : ".") +
        " The page may have changed while they had it. Look at it again " +
        "before relying on anything from before; that they handed back is " +
        "not evidence anything was done.";
      try {
        await this.deps.deliver(target, text, shot);
      } catch (err) {
        log.warn({ err }, "Could not tell the agent control was handed back");
      }
    }
    setLiveControlSnapshot({
      takeover:
        this.snapshot.takeover?.id === takeoverId
          ? null
          : this.snapshot.takeover,
    });
    this.setPaused(false);
    log.info({ outcome, reason }, "Control handed back");
  }

  private endLease(): void {
    this.clearLeaseTimer();
    if (this.snapshot.holder) {
      setLiveControlSnapshot({ holder: null });
    }
  }

  private setPaused(paused: boolean): void {
    if (paused === this.snapshot.paused) {
      return;
    }
    setLiveControlSnapshot(
      paused
        ? { paused }
        : { paused: false, pausedBy: null, conversationId: null },
    );
    if (!paused) {
      for (const waiter of [...this.pauseWaiters]) {
        waiter.resolve();
      }
    }
  }

  private armLeaseTimer(): void {
    this.clearLeaseTimer();
    this.leaseTimer = setTimeout(() => {
      this.leaseTimer = null;
      const holder = this.snapshot.holder;
      if (!holder) {
        return;
      }
      log.info({ holder: holder.id }, "Control lease expired");
      void this.handBack(
        holder.name,
        "cannot",
        "the control lease expired with nobody on the desktop",
        this.snapshot.takeover?.id ?? null,
        "lease_expired",
      );
    }, this.deps.leaseIdleMs ?? CONTROL_LEASE_IDLE_MS);
    this.leaseTimer.unref?.();
  }

  private clearLeaseTimer(): void {
    if (this.leaseTimer) {
      clearTimeout(this.leaseTimer);
      this.leaseTimer = null;
    }
  }

  private ok(conversationId?: string | null): ControlResponse {
    const state = this.snapshot;
    return {
      status: 200,
      body: {
        ok: true,
        state: {
          paused: state.paused,
          pausedBy: state.pausedBy,
          holder: state.holder,
          conversationId: conversationId ?? state.conversationId,
        },
      },
    };
  }
}

function parseActor(raw: unknown): LiveActor | null {
  const actor = (raw ?? {}) as Record<string, unknown>;
  const id =
    typeof actor.aexy_developer_id === "string"
      ? actor.aexy_developer_id.trim()
      : "";
  const role = typeof actor.role === "string" ? actor.role : "";
  if (!id || !ROLES.has(role)) {
    return null;
  }
  const name =
    typeof actor.display_name === "string" && actor.display_name.trim()
      ? actor.display_name.trim().replace(/[\r\n]+/g, " ")
      : id;
  return { id, name, role: role as LiveActor["role"] };
}

function person(actor: LiveActor): LivePerson {
  return { id: actor.id, name: actor.name };
}

function conflict(
  code: "control_held" | "no_active_run",
  extra: Record<string, unknown>,
): ControlResponse {
  return { status: 409, body: { ok: false, code, ...extra } };
}

function unprocessable(code: string, message: string): ControlResponse {
  return { status: 422, body: { ok: false, code, message } };
}

// ---------------------------------------------------------------------------
// Gates, for the agent loop and the tool executor
// ---------------------------------------------------------------------------

/**
 * The installed instance. The gates read it through these free functions so
 * the loop and executor need not import the daemon wiring that builds it;
 * until something installs one, nothing can be paused or held, and the gates
 * are no-ops.
 */
let installed: LiveControl | null = null;

export function installLiveControl(control: LiveControl | null): void {
  installed = control;
}

export function getInstalledLiveControl(): LiveControl | null {
  return installed;
}

/** Wait at a step boundary while a person has the agent paused. */
export function waitWhileLivePaused(
  conversationId: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  return (
    installed?.waitWhilePaused(conversationId, signal) ?? Promise.resolve()
  );
}

/** The refusal for a browser or computer-use tool while a person drives. */
export function liveToolRefusal(
  toolName: string,
  conversationId: string | undefined,
): string | null {
  return installed?.toolRefusal(toolName, conversationId) ?? null;
}
