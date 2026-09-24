# Watching an agent work, and taking the wheel

**Status:** In progress. Contracts: `AGENT_LIVE_VIEW_CONTRACTS.md`.
**Date:** 2026-09-24
**Spans:** `aexy` (this repo), `aexy-platform` (control plane, tunnel,
orchestrator), `bhanuc/aexy-assistant` (our vellum-assistant fork).
**Goal:** Put a card on a virtual employee and be able to *watch it do the
work* — the real browser, live — from the card, the agent's page, or one
"agents at work" screen. When it needs hands (a CAPTCHA, a 2FA prompt, a login,
a judgement call), a person takes control in the same view and hands it back.
The same run view shows Aexy's own agents and automations, so there is one
place to see what every non-human worker in the workspace is doing.
**Also plans:** the UX for creating, managing and sharing virtual employees
inside Aexy — the "Hosted assistants area" that `aexy-platform/docs/PLAN.md:321`
deferred to "its own plan". This is that plan.
**Predecessors:** `POD_TASK_ASSIGNMENT.md` (a pod can be given a card),
`HUMAN_HELP_REQUESTS.md` (a stuck pod can ask a person).

---

## 1. The point

Today a pod works a card and all you see is a `PodAtWorkBadge` and whatever
notes it chose to post to the card's activity feed, polled every 30 s
(`hooks/usePodWork.ts:48`). You cannot see the page it is on, you cannot tell
whether it is stuck or thinking, and when it hits a CAPTCHA the handoff code
waits five minutes for a human who was never told
(`browser-handoff.ts`, the `message` option is never delivered to any client).

Three things are missing, and they are separable:

1. **Seeing** — a live picture of the agent's screen plus a narrated timeline of
   what it is doing and why.
2. **Intervening** — pause, instruct, take control, hand back.
3. **Owning** — creating a virtual employee, deciding who may assign it work,
   watch it, or drive it, from inside Aexy.

## 2. What already exists (and what is quietly not true)

| Need | State |
| --- | --- |
| A streamable desktop in the pod | **Upstream, flag-gated.** PR #42021: Xtigervnc `:99` on loopback, openbox, Chrome, bridged to `/v1/desktop/stream` as raw RFB over WebSocket (`assistant/src/desktop/desktop-session-manager.ts`, `desktop-stream-bridge.ts`). Flag `assistant-desktop`, default off |
| A browser client for it | **Upstream.** noVNC 1.7, fully interactive (`clients/web/src/domains/chat/desktop/`) |
| The tunnel carrying browser WebSockets to a pod | **Built.** Binary WS relay (`tunnel/src/inbound.rs:336-420`); `/v1/desktop/stream` and `/v1/watch/stream` are already reserved as user-authenticated paths (`contracts/src/tunnel.rs:194-199`) behind a single-use 60 s `bvt_` token |
| Minting that token | **Missing.** `POST /v1/auth/live-voice-token/` is in `PLAN.md` but not routed, and the control plane has no Redis client. No browser can open either stream today |
| A live event stream of what the agent is doing | **Built in the pod.** `GET /v1/events` SSE: `assistant_activity_state`, `tool_use_start`, `tool_result` (with `imageData`), `question_request`, … (`runtime/routes/events-routes.ts`) — but not reachable through the tunnel, and the card runner never reports *which* conversation is working the card |
| Knowing a person should look | **Built for questions.** `/platform/human-help/ask` → `proposed_changes` kind `QUESTION` → `/requests`. Nothing for "come take over" |
| A stop button | **Built.** `POST pod-work/{claim}/stop`, lands at the next heartbeat |
| Aexy run records | **Three shapes.** `crm_agent_executions.steps` JSONB, `crm_workflow_execution_steps` rows, `pod_task_claims` + `task_activities`. All UIs poll (2 s / 15 s / 30 s). The only push channel is the chat WebSocket over Redis |
| An outbound client from Aexy to the platform | **Missing.** Traffic is only inward (control plane → Aexy). Aexy cannot hatch, list or configure an assistant |
| Sharing an assistant | **Missing on both sides.** Platform: any org member may act on any assistant (`auth/principal.rs:102-121`), but the pod's gateway accepts only the one guardian (`guardian-pin.ts:170-220`). Aexy: agents have `created_by_id` and nothing else |

**Three facts that shape the design:**

- **The desktop Chrome is not the agent's browser.** The agent drives a separate
  headless Playwright Chromium (`browser-manager.ts:328`, `headless =
  !canDisplayGui()`, and the daemon never sets `DISPLAY`). Streaming the
  desktop today shows an empty Chrome while the agent works invisibly beside it.
- **The desktop stream is one viewer, guardian only, and dies on a dropped
  frame** (`closeOnDroppedFrame: true`, close code 4013 for a second viewer).
  That is right for driving and wrong for watching.
- **Every socket to a pod shares one tunnel connection** with a 256-frame queue
  and base64-in-JSON frames. Video for N viewers through it naively is N× the
  pod's egress through one pipe.

## 3. Decisions

**D1 — The desktop is the agent's machine.** One browser, visible. When the
agent's browser tool starts in a pod, the X session starts with it, and the
agent drives the *desktop* Chrome over CDP (`--remote-debugging-port=9222` on
loopback, the existing `cdp-inspect` backend) instead of launching its own
headless Chromium. The desktop lives for as long as the agent is browsing, not
only while someone watches. This is the change everything else depends on; it is
small in code (`browserCommand()` at `desktop-session-manager.ts:713`, the
backend default, desktop lifecycle) and larger in cost (§7).

*Fallback if CDP-attach proves flaky:* launch Playwright headed with
`DISPLAY=:99` and drop the desktop's own Chrome. Same outcome, more divergence
from upstream.

**D2 — Two streams, because watching and driving have opposite needs.**

| | **Watch** | **Drive** |
| --- | --- | --- |
| Path | `/v1/watch/stream` (reserved, unused) | `/v1/desktop/stream` (built) |
| Carries | CDP `Page.startScreencast` JPEG frames **plus** the filtered event timeline, multiplexed on one socket | RFB (VNC) |
| Viewers | many | exactly one, holding the control lease |
| Dropped frames | fine — latest frame wins | fatal, so it stays on its own socket |
| Input | none | full desktop: mouse, keyboard, clipboard, OS dialogs |
| Bandwidth | ~0.3–2 Mbps, only on paint, adaptive fps | higher, only during a takeover |
| Works on phone | yes | desktop-first in v1 |

Screencast is the right default because it tolerates a slow viewer, costs
nothing when the page is still (Chrome only emits on paint, and the ack-based
flow control throttles to the slowest consumer we choose to wait for), and
shows *exactly* the tab the agent is on. VNC stays for takeover because a human
sometimes needs the whole desktop — a file picker, a permission prompt, a second
window — which CDP input injection cannot reach.

Not WebRTC, not now: pod media would need TURN (the tunnel is TCP), an encoder
under gVisor eats CPU the agent needs, and neither stream's bitrate justifies it.
Revisit if we ever stream full-motion desktops to many people.

**D3 — Aexy decides who may watch or drive; the platform enforces it.** The
access question ("may Priya drive Vega?") is a workspace question and belongs
in Aexy with the rest of workspace roles. The flow:

```
browser ──(1) POST /workspaces/{ws}/agents/{id}/live-session {mode}──► Aexy backend
Aexy backend: check agent role (§5 WS-7) ─(2) service-key call──► control plane
control plane: mint bvt_ token {assistant, aexy_developer_id, scope: watch|control}
                                      ◄── token + tunnel URL ──
browser ──(3) wss://<tunnel>/<assistant>/v1/watch/stream?token=bvt_…──► tunnel
tunnel: GETDEL token, inject x-velay-user-id + x-velay-stream-scope ──► pod gateway
gateway: authorize by attested scope (not only the guardian pin) ──► daemon
```

Aexy never sits in the frame path, so a busy stream never loads the Aexy
backend. The gateway change is the one real divergence from upstream's
guardian model, and it is scoped to these two paths.

**D4 — Asking beats taking over.** The user brief said "use it for
human-in-the-loop if there is no better plan". There is a better plan for most
cases, and it already exists: a structured question or approval is async,
answerable from a phone, auditable, and doesn't need anyone to be there at the
right moment. So human-in-the-loop is a ladder, and the agent is told to use the
lowest rung that works:

| Rung | When | Mechanism |
| --- | --- | --- |
| 1. **Ask** | a decision, missing info | `ask_question` → `/requests` (built) |
| 2. **Approve** | a risky action | policy gate `REQUIRE_APPROVAL` (built for Aexy agents; pods: WS-5) |
| 3. **Take over** | needs hands on the page: CAPTCHA, 2FA, login, visual judgement | new `request_takeover` → `/requests` kind `TAKEOVER` → live view in drive mode |

Takeover is the only rung that needs video, and it is deliberately the rarest.

**D5 — Handing back is explicit, and is not proof.** No five-minute URL-change
heuristic. A takeover ends when the person presses **Hand back** (with an
optional note), when their control lease expires, or when the request's
deadline passes. The agent then re-checks the page itself; "a handoff returning
is not evidence a human did anything" (`aexy-platform/docs/ANDROID_DEVICES.md`).
While a person holds control, the agent's input is locked and the claim's budget
clock is paused.

**D6 — One run view, pluggable right pane.** Pods, Aexy agents and workflows
get the same shell — header, timeline, controls — and differ only in what the
"live" pane shows. We do not build a new run store; each source gets an adapter
that projects its existing records into a common `RunEvent` shape.

**D7 — Virtual employees live in the Agents app, not a new app.** One list, two
kinds: *Aexy agent* (works inside Aexy through its API) and *Virtual employee*
(has a machine, a browser, a shell). Same page skeleton, same access model.
Hatching happens in Aexy; the control plane stays headless.

**D8 — An agent is personal or shared, and sharing is a scope.** Every agent,
of either kind, has a sharing scope:

| Scope | Who can find it, assign it cards, and guide it |
| --- | --- |
| **Personal** | the owner only; nobody else sees it in pickers or lists |
| **Team** | members of the named team(s) (`team_members`) |
| **Org** | every member of the workspace |

Scope decides who can *use* the agent. It never grants the powerful actions —
watching the live screen and taking control — on its own (D10).

**D9 — Every intervention is logged, and guiding is an intervention.** On a
shared agent anyone in scope may guide it: instruct a running turn, pause,
resume, answer its requests, comment on a step. Each of these is written to
the agent's **intervention log** with who, when, which run and step, and what
was said or done. The log is append-only, is shown on the run's timeline
("Arjun: use the second venue"), and the agent sees each instruction attributed
to the person ("Instruction from Arjun Mehta: …") so it can weigh and cite it.
A takeover is logged as a session with its start, end and hand-back note.
Nothing a person does to a shared agent's work is silent.

**D10 — Live access follows assignment; everyone else asks.** Being in scope
is not enough to see the screen. Watching and driving come with being
**already assigned** to the agent or to the work:

| Already assigned | Live access |
| --- | --- |
| The agent's owner and managers | every run of that agent |
| Whoever assigned the card to the agent, and the card's other assignees | that card's runs |
| The person a `request_takeover` or question was routed to | that run |
| A person who triggered an Aexy agent run or workflow execution | that run |

Watch and control come together for these people — they're already
accountable for the work. Access ends when the assignment does (unassigned
from the card, removed as manager).

Anyone else in scope gets it **on demand**: they press **Request access**
(watch, or watch + control) on the agent or on a run; the owner, a manager or
a workspace admin approves or declines. Owners and admins may approve their
own request (it is still a logged grant); a manager's own request goes to the
owner or an admin. A grant can be:

- **For this run** — ends when the claim or execution ends (the default).
- **Time-boxed** — 1 hour, 1 day, 1 week.
- **Standing** — until revoked, for people who operate the agent routinely.

Requests, grants, declines and revocations all go into the intervention log.
Assignment-based access isn't a stored grant — it's derived from the card and
the agent's roles at the moment of asking — but each watch or control session
it allows is still logged (`live_sessions`).

**D11 — Personal means not shared, not private from the company.** Aexy is
sold to companies. A personal agent still runs on the company's machines, holds
the company's data and sign-ins, and spends the company's money, so the company
must be able to see into it — the same expectation as admin access to a work
mailbox or drive. What "personal" buys the owner is that colleagues can't find,
use, guide or watch it. What it doesn't buy is a blind spot for admins.

| Admin action on a personal agent | Allowed | Friction |
| --- | --- | --- |
| See it exists, its status, spend, card history | always | none (it's in the Agents admin list) |
| Pause / stop a run, revoke a saved sign-in | always | owner notified |
| Watch live, read threads, see full thinking | yes | **reason required**, owner notified at once, time-boxed grant (max 24 h), shows on the owner's Log tab |
| Take control | yes | same as above, plus a banner in the owner's own run view while it's happening |
| Transfer ownership (offboarding) | yes | owner notified; the agent's personal-account sign-ins are removed on transfer, not inherited |
| Silent access | **never** | — there is no path that doesn't notify the owner and write the log |

**Workspace policy, for companies that want it stricter:** Settings → Agents →
*Admin access to personal agents*: **Notify owner** (default) or **Require
owner approval** (admin's request goes to the owner; a second admin can
override for an emergency, and both are logged). There is no "off" — a company
cannot opt out of being able to stop its own agents.

**Say it up front.** The virtual-employee wizard and the Sharing tab state it
in one line: *"Personal agents are private from your teammates. Workspace
admins can access them, and you'll be told when they do."* And because a
personal agent may still be used with company accounts, the §4.7 save dialog on
a personal agent warns when the account looks personal (a consumer email
domain), since an admin or a future owner could end up acting through it.

## 4. The UX

### 4.1 The run view (shared by all three kinds)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ◉ Vega · working "Book venue for offsite" · SPR-142   ⏱ 14m / 60m   $0.42   │
│ 👁 Priya, Arjun watching                [⏸ Pause] [💬 Instruct] [✋ Take over] [■ Stop] │
├───────────────────────────────┬──────────────────────────────────────────────┤
│ TIMELINE                      │ LIVE                                         │
│ 10:02 Claimed card            │ ┌──────────────────────────────────────────┐ │
│ 10:02 🧠 Plan: compare 3 …    │ │                                          │ │
│ 10:04 🌐 Opened venues.com    │ │     (screencast of the agent's tab)      │ │
│ 10:06 🌐 Filled search form   │ │                                          │ │
│ 10:09 📝 Progress: 2 options  │ │                                          │ │
│ 10:11 ⚠ CAPTCHA detected      │ └──────────────────────────────────────────┘ │
│ 10:11 ✋ Asked for takeover ● │  venues.com/checkout · 2 fps · Live ●        │
│       [Take over now]         │                                              │
│ ── scrub ─────────●───── now  │  [⤢ Full screen]  [📌 Comment on this step]  │
└───────────────────────────────┴──────────────────────────────────────────────┘
```

- **Timeline** is the agent's own event stream, condensed: turn starts, thinking
  summaries (collapsible, off by default for non-owners), tool calls with their
  inputs, progress notes, questions, approvals, takeovers, the submit. Clicking a
  step shows its detail (tool input/output, screenshot at that moment).
- **Live pane**, by kind:
  - *Virtual employee* → the screencast; becomes the VNC canvas in drive mode.
  - *Aexy agent* → "what it touched": live preview cards of the records it read
    or wrote (the contact, the draft email, the doc), updated as tool calls land,
    plus the ledger line for each write.
  - *Workflow* → the builder canvas with node state (reuse
    `useExecutionState.tsx`), current node pulsing.
- **Presence** — avatars of who is watching; one person at most holds control.
- **Scrubber** — after the fact, the same view replays the timeline (and, with
  recording on, the frames — WS-10).

**Where it opens from:** the `PodAtWorkBadge` on a card (click → run view in a
side sheet), the agent's page (**Live** tab), a `/requests` takeover item
(opens straight into drive mode), a notification, and the "agents at work"
screen.

### 4.2 Intervening

| Control | Who | What happens | Logged as |
| --- | --- | --- | --- |
| **Pause** | anyone in scope | Agent finishes the current tool call, then waits. Budget clock paused. Card badge says "Paused by Priya" | `pause` / `resume` |
| **Instruct** | anyone in scope | A message injected into the running turn, attributed to the sender ("use the second venue, not the first"). Shows in the timeline. Works without live access — guiding from the timeline alone is allowed | `instruct` with the text |
| **Take over** | holder of a control grant (D10) | Pauses, acquires the control lease, swaps the live pane to VNC. Banner: "You're driving Vega's browser. It can't act until you hand back. This session is logged." | `takeover_started` |
| **Hand back** | the controller | Optional note → agent resumes with the note and a fresh screenshot, re-verifies | `takeover_ended` + note, duration |
| **Stop** | anyone in scope | Existing `pod-work/{claim}/stop`, now delivered immediately over the control channel rather than at the next heartbeat | `stop` + reason |

Without a watch grant, a person in scope still sees the **timeline** (steps,
notes, questions) and can guide from it; the live pane shows **Request access**
instead of the screen.

**Pausing is real.** While paused — by a person or by a takeover — the claim's
wall-clock budget stops. Spend doesn't need pausing: no inference happens while
the agent waits.

**Request/grant control.** If Arjun holds control and Priya presses Take over,
Arjun sees "Priya asked for control — [Give] [Keep]"; the lease times out after
2 minutes of no input.

**Takeover request flow (agent-initiated):**

1. Agent calls `request_takeover {reason, what_to_do, deadline}` (e.g. "Solve the
   CAPTCHA and press Continue").
2. Pod posts `/platform/human-help/ask` with kind `TAKEOVER`; routing reuses
   `question_router` (assignee of the card → agent's help assignee → role).
3. Notification + `/requests` item: **"Vega needs your hands — CAPTCHA on
   venues.com"** with a thumbnail and **[Take over]**.
4. Person takes over, does it, presses **Hand back — done**. Or **Can't do it**
   → agent is told, releases or re-plans.
5. If nobody comes by the deadline: the request expires, the agent gets that as
   the answer, and does what the unattended policy says (`park` keeps holding
   the claim within its budget; `fail` releases the card).

### 4.3 Agents at work (workspace-wide)

`/agents/live` — the mission-control screen.

```
 NEEDS YOU (3)   ✋ Vega · CAPTCHA · 2m   ❓ Orion · "Which pricing tier?"   ✅ Draft email to Acme
 ───────────────────────────────────────────────────────────────────────────────
 WORKING NOW
 ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐
 │ [thumbnail]   │ │ [thumbnail]   │ │  Lead router  │ │ Nurture flow  │
 │ Vega          │ │ Lyra          │ │  (Aexy agent) │ │  (workflow)   │
 │ SPR-142 ⏱14m  │ │ SPR-150 ⏱3m   │ │  step 4/6     │ │  node: Wait   │
 │ 🌐 checkout   │ │ 🧠 thinking   │ │  📝 writing   │ │  resumes 14:00│
 └───────────────┘ └───────────────┘ └───────────────┘ └───────────────┘
 ASLEEP / IDLE   Orion (asleep 2h) · Nova (idle)
```

- "Needs you" merges `/requests` (questions, takeovers) and `/review` (approvals)
  for the current user — one list, per `HUMAN_IN_THE_LOOP.md:141`.
- Tiles are **thumbnails, not streams**: a snapshot every ~5 s from a cheap
  `GET /v1/watch/snapshot` (or the last screencast frame the watch relay holds).
  Hovering a tile upgrades it to the live stream; clicking opens the run view.
- Filters: kind, agent, "mine" (agents I own / cards I assigned).

### 4.4 Creating a virtual employee

Agents → **New** → first choice is the kind:

- **Aexy agent** — the existing `AgentCreationWizard`, unchanged.
- **Virtual employee** — a shorter wizard:

| Step | Fields | Lands in |
| --- | --- | --- |
| Identity | Name, handle (`@vega`), avatar, one-line role ("Ops assistant for events") | control plane `assistants` + Aexy `agent_principals` / `Developer` (existing WS-1 binding) |
| Machine | Size (plan-clamped: Small…XL, with what each costs), sleep after idle | `machine_size`, `idle_timeout_seconds` |
| Brain | Model profile (managed DeepSeek / Claude / …), monthly spend cap | managed profiles, `spend_controls` |
| Access to the world | Accounts & credentials it may use, each with allowed domains; "can browse", "can use shell" | `assistant_credentials.allowed_tools/allowed_domains` |
| How it works | Default budget per card, unattended questions (ask & wait / proceed / give up), working hours, who gets its questions | `workspace_pod_policies`, pod config, principal help routing |
| Sharing | Personal / Team (pick teams) / Org; managers; who may approve live-access requests | WS-7 scope + roles |
| Review | Summary + estimated monthly cost → **Hatch** | |

After **Hatch**: a live progress card (Provisioning → Starting → Ready) that
polls the control plane's status, then lands on the agent page with a
"Give Vega its first card" prompt that opens the assignee picker on the board.

### 4.5 Managing one

The agent page, tabbed. Aexy agents already have most of these; the tabs are
the same for both kinds, and a tab that doesn't apply is hidden.

| Tab | Virtual employee | Aexy agent |
| --- | --- | --- |
| **Overview** | Status (working / idle / asleep / stuck), current card, live thumbnail, this week's cards done, spend | existing live status strip |
| **Live** | Run view (§4.1) for the current claim | run view for the running execution |
| **Work** | Cards it has held: claimed / submitted / released / stopped, with outcome and time; each opens its replay | executions list (existing) |
| **Requests** | Questions and takeovers it raised, answered or not | existing inbox |
| **Chat** | Your own threads; owners/managers/admins also see everyone's (WS-12) | existing chat |
| **Settings** | Machine size, sleep, model, credentials, release channel (upgrade / roll back), restart, retire | existing edit |
| **Sharing** | Scope, managers, pending access requests, active grants (revoke) (§4.6) | same |
| **Log** | Intervention log: every instruction, pause, takeover, access grant — filterable by person and run | same |
| **Usage** | Inference, search, speech spend by day; budget burn per card | tokens / cost |

### 4.6 Collaborating

Access has three layers, applied to both kinds (an agent's principal is the
resource):

**1. Scope (D8) — who can use it.**

| Scope | In scope |
| --- | --- |
| Personal | owner only |
| Team | members of the chosen teams |
| Org | all workspace members |

In scope means: see it in lists and assignee pickers, assign it cards, see run
timelines, **guide** it (instruct, pause, resume, stop), answer its requests,
comment on steps. Out of scope, the agent is invisible. A personal agent
assigned to a shared card is visible on that card only as its assignee.

**2. Role — who can change it.**

| Role | Can |
| --- | --- |
| **Owner** | everything; retire; transfer; change scope; always has live access |
| **Manager** | settings, credentials, scope's team list, approve live-access requests |

Workspace admins are implicitly Manager on shared agents. On personal agents
they have oversight rather than management — see D11 for exactly what, and
the friction attached.

**3. Live access (D10) — who can see the screen or drive it.** Automatic for
people already assigned (owner, managers, whoever assigned the card, the
card's co-assignees, whoever the agent's request was routed to). Everyone else
in scope asks:

```
 Priya (in scope)            Vega's owner / managers
 ──────────────              ───────────────────────
 [Request access ▾]  ──────► 🔔 "Priya wants to watch + control Vega
   ○ Watch                        on SPR-142 — 'CAPTCHA looks stuck'"
   ● Watch + control              [Approve: this run ▾]  [Decline]
   reason: ___________                    │
                     ◄──────── granted ───┘   (logged both ways)
 Live pane unlocks; banner "Access until this run ends · logged"
```

When the agent asks for a takeover itself, the person it routes to is assigned
to that request, so they have access to that run with no approval step.

**The intervention log.** Every action by a person other than the agent, on
a shared agent's work — instruct, pause, resume, stop, answer, takeover
start/end with note, access request/grant/decline/revoke, settings change — is
one row: who, when, agent, run, step, action, payload. It is append-only,
appears inline on the run timeline, has its own **Log** tab, and on personal
agents it still records anything the owner didn't do themselves.

**Working together:** presence on the run view (who's watching, who's driving);
**comments pinned to a timeline step** ("this is where it picked the wrong
venue") that notify the owner and show on replay; **share a moment** — a link
to a step, which opens for people in scope and asks everyone else to request
access; **@mention the agent** in a card comment to guide it on its current
claim, logged like any instruction.

### 4.7 Saving a sign-in after a takeover

When a person takes over to get past a login or 2FA, they sign in inside the
pod's real Chrome. At hand-back, Aexy **asks them whether the agent should keep
that sign-in** — and if yes, it keeps both halves of it:

| Half | What it is | Why keep it |
| --- | --- | --- |
| **Credentials** | username + password typed into the login form | the agent can sign in again by itself when the session expires |
| **Session** | the site's cookies after sign-in (and after 2FA) | the agent skips login *and* 2FA until the site expires it — the only way past a 2FA the agent can't do |

```
 Hand back to Vega
 ─────────────────────────────────────────────────────────────
 You signed in to venues.com as ops@acme.com.
 Save this sign-in for Vega?
   ☑ Password — Vega can sign in again on its own
   ☑ Session  — Vega stays signed in (skips 2FA until it expires)
   Use on: ● venues.com only
 [Save sign-in]   [Don't save — sign Vega out when this card ends]
 ─────────────────────────────────────────────────────────────
 ⚠ This is a shared agent: everyone who can give Vega work will
   act as ops@acme.com on venues.com.
```

**How the credentials are caught — like a password manager, not a keylogger.**
The daemon does not read keystrokes (VNC input is never logged, recorded or
parsed). It watches the page over CDP for a form submit that contains a
password field — the same signal Chrome's own "Save password?" uses — and reads
the username and password *fields* at that moment. Those values are held **in
daemon memory only**, never in the event stream, the intervention log, the
timeline or a recording, and are discarded at hand-back unless the person says
save.

**Where they are saved — the credential vault, not the agent's memory.** The
agent's memory is text the model reads and sends to an LLM provider on every
turn; a password there would leak into prompts. Both halves go to the sealed
store the platform already has: `assistant_credentials` in the control plane
(sealed, bound to the assistant, write-only, replayed into the pod's
memory-backed vault by the existing credential loop). Concretely:

- password → `login:<domain>` credential, `allowed_domains = [<domain>]`, used
  by the credential executor so the model never sees the value;
- session → `session:<domain>` credential holding the cookie jar for that
  domain, replayed into Chrome with `Network.setCookies` when the browser
  starts, so it survives a profile reset or a pod rebuild.

**Rules.**

- On a **shared** agent, only owners, managers and admins can save (anyone who
  took over can still *choose* "don't save"); the dialog warns that everyone
  using the agent will act as that account. Someone else who took over sees
  "Ask an owner to save this sign-in", which files a request with the domain
  and account name — never the password.
- On a **personal** agent, the owner is asked and "Save" is the default.
- **Don't save** → the captured values are dropped and the new cookies for
  that domain are cleared when the card ends.
- Saved sign-ins are listed under Settings → **Sign-ins** (domain, account,
  saved by, when, last used) with **Remove**, which deletes the vault rows
  *first* and then clears the live cookies — the reverse order would bring
  them back on the next credential replay.
- Every save, decline and removal is an intervention-log row: who, domain,
  account name, which halves. Never the values.

This is WS-5 work: CDP form-submit capture and cookie diff in the daemon
**[V]**, a `session:` credential kind plus cookie replay at browser start
**[V][P]**, the hand-back dialog and Sign-ins settings **[A]**.

## 5. Workstreams

Tags: **[A]** aexy, **[P]** aexy-platform, **[V]** assistant fork.

### WS-0 — Spike: does a visible desktop fit in a gVisor pod? — **do first**
- Bake the desktop dependencies (TigerVNC, openbox, Chrome .deb) into our pod
  image instead of the runtime `apt install` in `desktop-dependencies.ts` — a
  first viewer waiting minutes for apt is not acceptable, and `/app` is
  read-only anyway. **[V]**
- On staging, run a card with the desktop flag on and D1's CDP-attach; measure
  pod CPU / RSS with the X session up, `/dev/shm` needs (Chrome crashes in a
  small one — may need a memory `emptyDir` in `builder.rs`), and screencast
  bitrate through the tunnel. **[P][V]**
- **Exit:** numbers for §7, and a yes/no on D1 vs its fallback. Two to three days.

### WS-1 — One visible browser (D1) **[V]**
- Desktop Chrome gets `--remote-debugging-port=9222` on loopback; when the
  desktop feature is on in a pod, the browser backend defaults to `cdp-inspect`.
- The desktop session starts when the browser tool first needs it and lingers
  while a claim is open, not only while a viewer is connected.
- Tests: the browser tool drives the same target the desktop shows.

### WS-2 — Stream tokens **[P][A]**
- Control plane: Redis client; `POST /v1/assistants/{id}/stream-token
  {aexy_developer_id, scope}` behind `x-platform-service-key`, writing the
  `bvt_` token the tunnel already consumes, now carrying `scope`.
- Tunnel: inject `x-velay-stream-scope` next to `x-velay-user-id`.
- Aexy: a `PlatformClient` (the first outbound client; lives in `services/`,
  base URL + service key in `core/config.py`) and
  `POST /workspaces/{ws}/agents/{id}/live-session {mode}` that checks the WS-7
  role and returns `{url, token, expires_in}`.

### WS-3 — The watch stream **[V]**
- `/v1/watch/stream` in the daemon and gateway: authorize by attested scope
  (`watch` or `control`); many viewers.
- Server → client, one socket: JSON event frames (the `/v1/events` types,
  filtered to the claim's conversation, thinking deltas omitted unless the
  viewer is the owner) and binary JPEG frames from `Page.startScreencast`
  (`format: jpeg, quality ~60, maxWidth 1280`, `everyNthFrame` adaptive).
  Thinking deltas go only to viewers the token marks as owner, manager or
  admin; others get the step summaries.
  Screencast runs only while ≥1 viewer is connected; a slow viewer gets the
  latest frame, not a backlog.
- `GET /v1/watch/snapshot` → last frame, for tiles.
- An open viewer counts as activity (`record-activity`, throttled), so the pod
  isn't put to sleep under someone watching.
- The runner reports the conversation id on claim and heartbeat, so Aexy can
  say which run a card is. **[V][P][A]** (one column on `pod_task_claims`.)

### WS-4 — Run view for pods **[A]**
- `components/runs/RunViewer` (shell, timeline, controls) with a `ScreenPane`;
  `useLiveSession` (token fetch, socket, reconnect on 4801 / pod refresh every
  55 min, frame decode to `<canvas>` via `createImageBitmap`).
- Entry points: `PodAtWorkBadge` → side sheet; agent **Live** tab.
- Translations in `messages/{en,hi}/runs.json`.
- **Ship here:** watch-only live view on a card. This is the first thing a user
  can see.

### WS-5 — Intervene: pause, instruct, take over, hand back **[V][P][A]**
- **[V]** A control channel on the watch socket (control-scope viewers only):
  `pause`, `resume`, `instruct {text}`, `stop`, `acquire_control`,
  `release_control {note}`. The daemon holds a control lease; while held, the
  agent's browser/computer-use tools refuse with "a person is driving" and the
  turn waits.
- **[V]** Replace `startHandoff`'s URL-change wait with `request_takeover`,
  which posts a `TAKEOVER` human-help request and waits for release, expiry or
  deadline (D5). The CAPTCHA path in `browser-execution.ts:1230-1330` calls it.
- **[A]** `proposed_changes` kind `TAKEOVER` (migration + `QuestionKind`),
  routing through `question_router`, a `/requests` card with thumbnail and
  **Take over**, and the budget clock paused while a takeover is open
  (`pod_task_claims`).
- **[A]** Drive mode in `RunViewer`: `DesktopPane` with noVNC (lift from
  upstream `clients/web/src/domains/chat/desktop/`), request/grant control UI.
- **[A]** Every control message is written to `agent_interventions` (WS-7)
  before it is forwarded to the pod; `instruct` text is sent to the agent with
  the sender's name attached. Watch and control socket sessions go in
  `live_sessions` (who, agent, run, `watch|control`, grant id, start, end, end
  reason).
- **[A]** The control channel goes **through Aexy**, not straight to the pod,
  so nothing reaches the agent unlogged: the browser sends control messages to
  `POST /workspaces/{ws}/runs/{kind}/{id}/control`, Aexy checks scope/grant,
  logs, and relays to the pod over the platform (frames still go
  browser ↔ tunnel directly). **[P]** a service-key relay route for it.
- **[A]** Pause stops the claim's wall-clock budget (`paused_seconds` on
  `pod_task_claims`, subtracted in the expiry sweep); Aexy agents and
  workflows honour pause at their next step boundary.

### WS-6 — Virtual employees in the Agents app **[A][P]**
- `PlatformClient` grows hatch, get, list, patch, restart, resize, sleep
  policy, upgrade/rollback, retire, credentials — each an Aexy endpoint under
  `/workspaces/{ws}/agents/hosted/…` that checks the WS-7 role and calls the
  control plane. Hatch writes the agent principal with `assistant_id` in the
  same request (today a separate settings step).
- Frontend: kind picker on **New**, the virtual employee wizard (§4.4), the
  tabbed agent page (§4.5), the unified agents list with a kind filter.
- **[P]** A service-key path for hatch that names the acting Aexy developer
  (hatch is person-only today via `/v1/auth/exchange`); the developer becomes
  `owner_user_id`.

### WS-7 — Sharing, roles, grants and the intervention log **[A][P][V]**
- **[A]** Migrations:
  - `agent_sharing (principal_id, scope personal|team|org)` +
    `agent_sharing_teams (principal_id, team_id)`.
  - `agent_members (principal_id, developer_id, role owner|manager)`.
  - `agent_access_requests (id, principal_id, requester_id, mode watch|control,
    run_kind, run_id, reason, status, decided_by_id, decided_at)`.
  - `agent_access_grants (id, principal_id, developer_id, mode, run_kind,
    run_id NULL, expires_at NULL, granted_by_id, revoked_at)` — `run_id` set =
    this run only; `expires_at` set = time-boxed; both null = standing.
  - `agent_interventions (id, principal_id, run_kind, run_id, step_ref,
    actor_id, action, payload JSONB, created_at)` — append-only (no update or
    delete path in the service; a DB trigger refuses them).
- **[A]** `AgentAccess.can(dev, agent, action)` — the one resolver every agent
  API, pod-work stop, live-session, control and hosted endpoint calls. Scope
  gates `use`/`guide`; role gates `configure`; `watch`/`control` is allowed
  when the person is **assigned** (owner/manager; card assigner or assignee
  via `SprintTask.assignee_id`, `TaskAssignee` and the claim's assigning
  actor; the routed recipient of an open `TAKEOVER`/`QUESTION`; the
  trigger of an Aexy run) **or** holds an unexpired grant. Also filters agent
  lists and the assignee picker.
- **[A]** Request/approve UI (§4.6), notifications to owner and managers,
  grants expiring with the run (claim end / execution end hooks).
- Backfill: creator → Owner; existing agents → scope **org** (today's
  behaviour, so nothing disappears from anyone's board), no live grants.
- **[P]** Keep `may_act_on_assistant` org-wide for service calls but refuse
  user-session writes from non-owners until the control plane learns roles —
  Aexy is the authority, so user-facing writes go through Aexy.
- **[V]** The stream paths authorize by attested scope (WS-3); chat for
  everyone with access is WS-12.

### WS-8 — A run event bus in Aexy **[A]**
- `services/run_events.py`: publish `{run_kind, run_id, event}` on a Redis
  channel per workspace (the `chat_pubsub.py` pattern), and
  `GET /workspaces/{ws}/runs/{kind}/{id}/events` as SSE (fetch-reader on the
  client, like `useAgentChatStream.ts`).
- Publish points: `BaseAgent` where it appends a step (`agents/base.py`), the
  workflow step writer, `platform_tasks` activity / blocked / submit.
- Replace the 2 s / 15 s / 30 s polling in `useAgents.ts:376` and
  `usePodWork.ts:48` with the stream, keeping polling as the fallback.

### WS-9 — Run view for Aexy agents and workflows **[A]**
- Adapters: `crm_agent_executions.steps` → `RunEvent`, `crm_workflow_execution_steps`
  → `RunEvent`; `EntityPane` (records touched, from tool calls + ledger) and
  `CanvasPane` (reusing `useExecutionState`).
- Retire the broken `/agents/{id}/executions/{execId}` link in
  `AgentExecutionLog.tsx:292` by making it a real route to the run view.
- `/agents/live` (§4.3) with the merged "needs you" list.

### WS-10 — Recording and replay (optional) **[V][P][A]**
- While a claim is open, keep a keyframe at every tool call and at most one
  frame every 5 s, upload to RustFS on submit/release, expose on the run view
  scrubber. Off by default per workspace; retention setting; frames on pages the
  credential executor filled are skipped.

### WS-12 — Everyone with access gets their own chat **[V][P][A]**
- **[V]** The gateway's guardian pin allows one person to chat. Extend it: a
  chat request whose tunnel- or proxy-attested user is on the agent's
  access list (pushed from Aexy via the control plane on every change) is
  accepted, and gets **its own conversations** keyed by that user — no one
  reads another person's thread through the pod.
- **[V]** Each turn's system context names the speaker ("You are talking with
  Arjun Mehta, a member of the Ops team"), so the agent knows whose request it
  is and doesn't treat one person's instruction as the owner's.
- **[P]** The orchestrator proxy stops hard-injecting `owner_user_id` as the
  user and passes the acting user through instead.
- **[A]** The agent's **Chat** tab lists your own threads; owners, managers and
  admins additionally see an index of everyone's threads (who, when, title) and
  can open them — logged as an intervention-log `view_thread` row.
- Chat turns that change the agent's standing behaviour (memory, settings it
  can edit itself) are logged as interventions; plain conversation is not
  duplicated into the log, it's already in the thread.

### WS-11 — Later
- Tunnel fan-out for `/v1/watch/stream` (the pod sends each frame once and the
  tunnel multicasts) and a binary frame type in the tunnel protocol (drops the
  base64 tax). Only needed once viewers per pod regularly exceed a handful.
- Takeover on phones (touch → VNC is poor; a CDP-input "tap the page" mode may
  be enough for CAPTCHAs).

**Order:** WS-0 → WS-1 → WS-2 → WS-3 → WS-4 (**watch ships**) → WS-5
(**takeover ships**). WS-6/7 can run in parallel from the start (mostly
frontend + `PlatformClient`). WS-12 (per-person chat) after WS-7, since it
reads the access list. WS-8/9 after WS-4, reusing its components.
WS-10/11 on demand.

## 6. Questions

**Decided (2026-09-24):**

- **Personal or shared** — both; scope is personal / team / org (D8).
- **Interference on a shared agent** — allowed for anyone in scope, and always
  logged (D9, intervention log).
- **Guiding** — people in scope can guide a shared agent (instruct, pause,
  @mention on its card); every instruction is logged and attributed (D9).
- **Pause** — takeovers and manual pauses pause the agent and its wall-clock
  budget (§4.2).
- **Live access** — automatic for people already assigned to the agent or the
  work (owner, managers, card assigner and assignees, the routed recipient of
  a request); everyone else in scope requests it and the owner or a manager
  approves (D10).

- **Thinking** — full thinking is visible to the owner, managers and workspace
  admins. Everyone else with live access sees the step summaries only.
- **Chat** — anyone with access to the agent can open their own free-form chat
  with it (WS-12). Each thread is theirs, is attributed, and is logged.
- **Self-approval** — owners and workspace admins may grant themselves live
  access; the self-grant is logged like any other. Managers' requests go to
  the owner or an admin.
- **Sign-ins after a takeover** — the person is asked whether to save it; if
  yes, both the password and the session are saved to the credential vault
  (§4.7).
- **Admins and personal agents** — personal means *not shared*, not *private
  from the company*. Admins keep oversight, with friction and a trail (D11).

**Still open:** none.

## 7. Risks worth stating plainly

- **Cost of D1.** A visible desktop means Xvnc + a full Chrome for every pod
  that is browsing, not just ones being watched. Chrome was already running
  (headless), so the delta is the X server and compositor — expected tens of
  MB and a little CPU, but WS-0 must measure it under gVisor before we commit.
- **Everything goes through one tunnel socket per pod.** A takeover VNC stream
  and three watchers on one pod share a 256-frame queue with the pod's webhooks
  and task calls. Screencast's latest-frame-wins keeps watchers from starving
  it; VNC does not drop, so one takeover at a time is a real limit, not a UX
  choice.
- **Screens show secrets.** Anything on the page is in the stream and, with
  WS-10, in storage. Roles, audit, recording off by default, and skipping
  credential-filled pages are the mitigations — not a guarantee.
- **Diverging from upstream.** D1 and the gateway's scope check change files
  upstream actively edits (`desktop-session-manager.ts`, `guardian-pin.ts`,
  browser backends). Keep the changes small and behind the existing
  `assistant-desktop` flag plus a fork flag, and rebase often.
- **A pod that sleeps can't be watched.** Tiles show "asleep" with the last
  frame. A card assigned to a sleeping pod shows nothing live until it wakes
  on its next heartbeat (up to the WS-4 wake interval in `POD_TASK_ASSIGNMENT.md`).

## 8. Non-goals

- WebRTC or H.264 encoding in the pod.
- Watching Aexy agents "on a screen" — they have no screen; they get the entity
  pane.
- Letting a viewer drive without the control lease, or two drivers at once.
- A second task system: every run the view shows is an existing card claim,
  agent execution or workflow execution.
- A standalone web client for the platform — the Aexy frontend is the client.
