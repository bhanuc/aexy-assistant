# Agent live view — cross-repo contracts

**Companion to:** `AGENT_LIVE_VIEW_PLAN.md` (the why and the UX). This file is
the *what exactly*: every endpoint, header, socket frame and Python/TS
interface that more than one branch depends on. Work in all three repos is
built in parallel against this file. **If you need to change a contract,
change it here first** and say so in your commit message.

Repos: **[A]** `aexy` (backend + frontend), **[P]** `aexy-platform`
(control plane, tunnel, orchestrator), **[V]** `aexy-assistant` fork
(`assistant/` daemon, `gateway/`).

Vocabulary:

- **principal** — `agent_principals.id` in Aexy. Every agent of either kind
  has one; it is the resource all access is keyed on.
- **assistant** — `assistants.id` in the control plane; a virtual employee's
  pod. `agent_principals.assistant_id` links them.
- **run** — `RunRef{kind, id}` with `kind ∈ pod_claim | agent_execution |
  workflow_execution`; ids are `pod_task_claims.id`,
  `crm_agent_executions.id`, `crm_workflow_executions.id`.
- **viewer role** — `owner | manager | admin | member`. Decides what a viewer
  is sent (full thinking only for `owner|manager|admin`).
- **scope** (of a stream token) — `watch | control | chat`.

---

## C1. Stream tokens — [A] → [P] → tunnel → [V]

### C1.1 Mint — control plane, service-key

```
POST /v1/service/assistants/{assistant_id}/stream-tokens
x-platform-service-key: <key>
{
  "aexy_workspace_id": "uuid",
  "aexy_developer_id": "uuid",
  "display_name": "Priya Shah",
  "scope": "watch" | "control" | "chat",
  "viewer_role": "owner" | "manager" | "admin" | "member",
  "path": "/v1/watch/stream" | "/v1/desktop/stream",
  "live_session_id": "uuid",
  "conversation_id": "string | null"
}
→ 201 {
  "token": "bvt_…",
  "url": "wss://<tunnel-host>/<assistant_id>/v1/watch/stream?token=bvt_…",
  "expires_in": 60,
  "pod_state": "awake" | "waking"
}
```

- 404 unknown assistant or assistant not in the org mapped from
  `aexy_workspace_id`. 409 `{code:"retired"}`.
- `scope=control` is required for `path=/v1/desktop/stream`; 422 otherwise.
- `scope=chat` only for `/v1/watch/stream` and requires `conversation_id`.
- Minting wakes a sleeping pod (same path the orchestrator proxy uses) and
  counts as activity.
- The control plane resolves `aexy_developer_id` to a `users` row (creating it
  if missing, same as `/v1/auth/exchange` does) — that `users.id` is the
  platform user id the tunnel attests.

### C1.2 Token payload (Redis, consumed by the tunnel with GETDEL)

Extends the existing `bvt_` record with:
`scope`, `viewer_role`, `live_session_id`, `aexy_developer_id`,
`display_name`, `conversation_id`, `path`. A token is only valid for its
`path`.

### C1.3 Headers the tunnel injects on the relayed WebSocket

Existing: `x-velay-user-id`, `x-velay-org-id`, `x-velay-actor: user`,
`x-velay-forwarded`. **New** (stripped from client input like the others):

| Header | Value |
| --- | --- |
| `x-velay-stream-scope` | `watch \| control \| chat` |
| `x-velay-viewer-role` | `owner \| manager \| admin \| member` |
| `x-velay-live-session-id` | uuid |
| `x-velay-aexy-developer-id` | uuid |
| `x-velay-display-name` | URL-encoded UTF-8 |
| `x-velay-conversation-id` | present iff set on the token |

### C1.4 Gateway → daemon

The gateway authorizes `/v1/watch/stream` and `/v1/desktop/stream` by these
attested headers **instead of** the guardian pin when `x-velay-stream-scope`
is present (guardian-pin path unchanged otherwise). It forwards to the daemon
as `x-vellum-viewer-id` (= `x-velay-user-id`), `x-vellum-viewer-role`,
`x-vellum-stream-scope`, `x-vellum-live-session-id`,
`x-vellum-aexy-developer-id`, `x-vellum-display-name`,
`x-vellum-conversation-id`, plus the existing gateway service token.
`/v1/desktop/stream` with scope ≠ `control` → close 4003.

---

## C2. Watch stream — `/v1/watch/stream` [V], consumed by [A] frontend

WebSocket. One socket carries the event timeline and screencast frames.

**Query:** `token` (tunnel), optional `conversationId` (ignored unless it
matches the token's for `chat` scope). Target conversation, in order: the
token's `conversation_id`; the active workspace-task conversation; the most
recent background conversation.

### Server → client, text frames (JSON)

```jsonc
{"type":"hello","protocol":1,
 "viewer":{"id":"…","role":"member","scope":"watch","liveSessionId":"…"},
 "conversationId":"…|null",
 "desktop":{"state":"off|starting|ready","width":1440,"height":900},
 "control":{"paused":false,"pausedBy":null,"holder":null}}

{"type":"event","seq":123,"emittedAt":"ISO","conversationId":"…",
 "event":{ /* the daemon's own event message, exactly as /v1/events sends it:
            assistant_activity_state, tool_use_start, tool_result,
            assistant_text_delta, message_complete, question_request, … */ }}
// assistant_thinking_delta is sent only to viewer.role ∈ owner|manager|admin.
// tool_result.imageData / imageDataList are stripped (frames carry the picture).
// scope=chat: events only, never frames.

{"type":"frame","seq":456,"ts":"ISO","width":1280,"height":800,
 "url":"https://…","title":"…"}   // immediately followed by ONE binary frame: JPEG bytes

{"type":"presence","viewers":[{"id":"…","name":"…","role":"…","scope":"watch"}]}

{"type":"control_state","paused":true,"pausedBy":{"id":"…","name":"…"},
 "holder":{"id":"…","name":"…"}|null,
 "takeover":{"id":"…","reason":"…"}|null}

{"type":"error","code":"…","message":"…"}
```

### Client → server (JSON)

`{"type":"ping"}` → `{"type":"pong"}`;
`{"type":"quality","maxFps":1-10}` (default 4).
No control commands on this socket — control goes through Aexy (C4).

### Behaviour

- Screencast (`Page.startScreencast`, `format:"jpeg"`, `quality:60`,
  `maxWidth:1280`, `maxHeight:800`) runs only while ≥1 frame-receiving viewer
  is connected, on the page the agent's browser tool currently targets.
  Latest-frame-wins per viewer: a viewer whose socket is backed up skips frames,
  never queues them.
- An open viewer calls the platform's record-activity (throttled to 30 s) so the
  pod isn't slept.
- On connect a `frame` with the last known frame is sent immediately if any.

### Close codes

`4003` forbidden · `4008` desktop feature disabled · `4010` agent has no browser
open (socket stays usable for events; this is sent as `error` not close) ·
`4013` (desktop stream only) someone else holds control · `4801` tunnel dropped
(reconnect with a fresh token).

### C2.1 Snapshot (service path, for tiles)

`GET /v1/watch/snapshot` on the gateway, **service-authenticated only** (not a
tunnel user path). → `200 image/jpeg` with headers `x-frame-ts`, `x-frame-url`,
or `204` when no frame exists. Reached from [P] C5.

---

## C3. Desktop stream — `/v1/desktop/stream` [V]

Unchanged RFB bridge from upstream, except: authorized by C1.4 with
`scope=control`, and **only the current control-lease holder** (C4
`acquire_control`) may open it; anyone else → close 4013. Closing the socket
does not release the lease; `release_control` does, or 120 s with the socket
closed.

---

## C4. Control — [A] → [P] → [V]

### C4.1 Aexy → control plane (service-key)

```
POST /v1/service/assistants/{assistant_id}/live/control
{
  "command": "pause" | "resume" | "instruct" | "stop" | "acquire_control"
           | "release_control" | "signin_decision",
  "actor": {"aexy_developer_id":"uuid","display_name":"…","role":"owner|manager|admin|member"},
  "intervention_id": "uuid",          // Aexy's agent_interventions row, already written
  "conversation_id": "string | null",
  "claim_id": "uuid | null",
  "text": "…",                        // instruct
  "note": "…", "outcome": "done" | "cannot",   // release_control
  "takeover_id": "uuid | null",       // release_control of an agent-requested takeover
  "domain": "…", "save_password": true, "save_session": true   // signin_decision
}
```

The control plane relays it unchanged, via the orchestrator proxy (wakes the
pod), to the gateway `POST /v1/live/control` (service-authenticated), which
forwards to the daemon `POST /v1/live/control`. Response passes back verbatim.

### C4.2 Daemon semantics and response

```jsonc
200 {"ok":true,
     "state":{"paused":bool,"pausedBy":{…}|null,"holder":{…}|null,
              "conversationId":"…|null"},
     "signinCandidates":[{"domain":"venues.com","username":"ops@acme.com",
                          "hasPassword":true,"cookieCount":14}]   // release_control only
    }
409 {"ok":false,"code":"control_held","holder":{…}}
409 {"ok":false,"code":"no_active_run"}
```

- `pause` — the running turn finishes its current tool call, then waits before
  the next model call or tool. `resume` releases it.
- `instruct` — appended to the target conversation as a user message:
  `Instruction from {display_name} ({role}): {text}`. Mid-turn, it is delivered
  at the next step boundary. Never dropped: if no turn is running it starts one.
- `stop` — aborts the running turn; if it is a workspace task, releases it with
  reason `Stopped by {display_name}`.
- `acquire_control` — implies `pause`; grants the lease to `actor`. Browser and
  computer-use tools refuse with "A person is driving the browser" while held.
- `release_control` — ends the lease, resumes, and appends
  `{display_name} handed back control ({outcome}): {note}` plus a fresh page
  screenshot to the conversation. The agent must re-verify the page. Returns
  `signinCandidates` captured during the lease (§4.7 of the plan).
- `signin_decision` — for one candidate domain: if `save_password` /
  `save_session`, the daemon sends the captured values **directly** to the
  control plane (C7) — they never pass through Aexy. Otherwise it drops them and
  schedules cookie removal for that domain when the current claim ends.

---

## C5. Service relays for Aexy — [P], all `x-platform-service-key`

Every request also carries `x-aexy-workspace-id` and `x-aexy-developer-id`
(the acting person). The control plane checks the assistant is in that
workspace's org.

| Method & path | Purpose |
| --- | --- |
| `POST /v1/service/assistants` | hatch; body below; acting developer becomes `owner_user_id` |
| `GET /v1/service/assistants` | list the workspace org's assistants |
| `GET /v1/service/assistants/{id}` | one assistant incl. status |
| `PATCH /v1/service/assistants/{id}` | `{name?, description?, idle_timeout_seconds?}` |
| `POST /v1/service/assistants/{id}/restart` | |
| `POST /v1/service/assistants/{id}/resize` | `{machine_size}` |
| `POST /v1/service/assistants/{id}/upgrade` | `{version?}` |
| `POST /v1/service/assistants/{id}/rollback` | |
| `POST /v1/service/assistants/{id}/retire` | |
| `GET /v1/service/assistants/{id}/usage?from=&to=` | daily spend by category, micro-USD |
| `GET /v1/service/assistants/{id}/credentials` | metadata only `[{name, allowed_tools, allowed_domains, created_at}]` |
| `PUT /v1/service/assistants/{id}/credentials/{name}` | `{value, allowed_tools, allowed_domains}` |
| `DELETE /v1/service/assistants/{id}/credentials/{name}` | durable row first, then live vault |
| `GET /v1/service/assistants/{id}/signins` | `[{domain, username, has_password, has_session, saved_by_aexy_developer_id, saved_at, last_used_at}]` |
| `DELETE /v1/service/assistants/{id}/signins/{domain}` | removes `login:<domain>` + `session:<domain>`, then tells the pod to clear that domain's cookies |
| `POST /v1/service/assistants/{id}/stream-tokens` | C1.1 |
| `POST /v1/service/assistants/{id}/live/control` | C4.1 |
| `GET /v1/service/assistants/{id}/watch/snapshot` | C2.1 relayed |
| `PUT /v1/service/assistants/{id}/access-list` | C6 |
| `GET /v1/service/assistants/{id}/threads?user=all\|<aexy_developer_id>` | `[{conversation_id, aexy_developer_id, title, updated_at}]` |
| `POST /v1/service/assistants/{id}/chat/messages` | `{conversation_id?, text}` → `{conversation_id}`; sent as the acting developer; replies are read on a `scope=chat` watch stream |

Hatch body:

```json
{"name":"Vega","handle":"vega","description":"Ops assistant for events",
 "machine_size":"small|medium|large|xl","idle_timeout_seconds":1200,
 "model_profile":"string|null","monthly_spend_cap_cents":5000}
```

Assistant JSON (all reads): `{id, name, handle, description, status,
machine_size, idle_timeout_seconds, current_release_version, release_channel,
last_activity_at, pod_state: "awake|asleep|waking|provisioning|failed",
created_at}`.

---

## C6. Access list — [P] → [V] gateway (WS-12)

Aexy `PUT`s the full list on every change (C5); the control plane translates
`aexy_developer_id → users.id` and pushes to the gateway
`PUT /v1/live/access-list` (service-authenticated):

```json
{"entries":[{"platform_user_id":"…","aexy_developer_id":"…","display_name":"…",
             "role":"owner|manager|admin|member","can_chat":true}]}
```

The gateway accepts chat from any `can_chat` entry (in addition to the
guardian), keys conversations by that user, and never serves one user's
conversation to another except to `owner|manager|admin` via the threads index.
The daemon prefixes each such turn's context with
`You are talking with {display_name} ({role}).`

**Gateway side, exactly** (all behind the fork flag `aexy-live-view`; off, these
paths fall through to the runtime proxy as upstream):

- *Service-authenticated* (`PUT /v1/live/access-list`, `POST /v1/live/control`,
  `GET /v1/watch/snapshot`, `GET /v1/live/threads`, `POST /v1/live/chat/messages`)
  means: on a managed pod, the orchestrator's `x-vellum-user-id` is either the
  stored `platform_user_id` (the guardian) or the `platform_user_id` of an entry
  on this list; elsewhere, the guardian's own actor edge JWT. Anything relayed
  by velay is refused. Until WS-12 [P] passes the acting user through, the
  orchestrator sends the owner and every call acts as the guardian.
- `PUT /v1/live/access-list` — from the guardian or an `owner|manager|admin`
  entry. Replaces the list; `200 {"ok":true,"entries":n}`; `400` on a bad entry
  or a `platform_user_id` listed twice. Stored in the gateway security dir
  (`aexy-live-access.json`), which the daemon cannot read.
- `POST /v1/live/chat/messages` `{conversation_id?, text}` → `{conversation_id}`
  (the C5 chat relay, unchanged). From the guardian or a `can_chat` entry
  (`403 {code:"chat_not_allowed"}` otherwise). A conversation belongs to the
  entry that started it here; one nobody on the list started is the
  guardian's. Posting to anyone else's → `403 {code:"not_your_conversation"}`.
  Delivered as the daemon's `POST /v1/messages`
  (`{conversationId?, content, sourceChannel:"vellum", interface:"vellum"}`) on
  the guardian's actor principal — the only actor the daemon knows — plus, for
  an entry, the acting-user headers below. Daemon errors pass back verbatim.
- `GET /v1/live/threads?user=all|<aexy_developer_id>` — the guardian and
  `owner|manager|admin` entries as asked; a `member` entry always gets
  `user=<their own aexy_developer_id>` (asking for `all` or someone else → 403).
- A `scope=chat` watch stream (C1.4) by a `member` viewer is closed 4003 unless
  the token's conversation is one that viewer started.

**Acting-user headers** (gateway → daemon, only for an entry that is not the
guardian; stripped from every client request, like the C1.4 viewer headers):

| Header | Value |
| --- | --- |
| `x-vellum-acting-user-id` | the entry's `platform_user_id` (same id space as `x-vellum-viewer-id`) |
| `x-vellum-acting-user-name` | `display_name`, URL-encoded UTF-8 (like `x-velay-display-name`) |
| `x-vellum-acting-user-role` | `owner \| manager \| admin \| member` |
| `x-vellum-acting-aexy-developer-id` | the entry's `aexy_developer_id` (what the threads index is keyed by) |

A request carrying these arrives on the guardian's principal; the daemon must
treat it as that person, not as the guardian.

---

## C7. Saved sign-ins — [V] pod → [P] (pod credential)

```
POST /v1/pod/signins
Authorization: Bearer <assistant api key>
{"domain":"venues.com","username":"ops@acme.com",
 "password": <string | null>,"cookies":[ CDP Network.Cookie … ] | null,
 "saved_by_aexy_developer_id":"uuid","intervention_id":"uuid"}
→ 201 {"saved":["login","session"]}
```

Stored as sealed `assistant_credentials` rows `login:<domain>` (value =
`{username,password}`, `allowed_domains=[domain]`) and `session:<domain>`
(value = cookie array). Delivered to the pod by the existing credential replay.
The daemon replays `session:*` into Chrome with `Network.setCookies` at browser
start. `login:*` is exposed to the credential executor only.

---

## C8. Human-help and tasks — additions to existing routes

- **Takeover asks.** `POST /v1/human-help/ask` (pod) and Aexy
  `POST /platform/human-help/ask` accept `"kind":"question"|"takeover"`
  (default `question`). Takeover adds
  `{"takeover":{"reason":"…","what_to_do":"…","deadline_seconds":1800,
  "page":{"url":"…","title":"…"}}}` and `questions` may be empty.
  `GET /…/human-help/{id}` statuses add `in_progress` (someone holds control).
  On hand-back Aexy marks it `answered` with
  `responses=[{"outcome":"done|cannot","note":"…","by":"display name"}]`.
- **Conversation id.** Pod `POST /v1/tasks/{id}/claim` and `/heartbeat` bodies
  accept `"conversation_id":"…"`; relayed to Aexy; stored on
  `pod_task_claims.conversation_id`.

---

## C9. Aexy backend — Python interfaces shared between branches

`backend/src/aexy/services/agent_access.py` (owned by the access branch; the
runs branch imports it, never edits it):

```python
class AgentAction(StrEnum):
    USE = "use"                # see in lists/pickers, assign work, see timelines
    GUIDE = "guide"            # instruct / pause / resume / stop / answer
    CONFIGURE = "configure"    # settings, credentials, sharing
    WATCH = "watch"            # live screen
    CONTROL = "control"        # take over
    VIEW_THINKING = "view_thinking"

RunKind = Literal["pod_claim", "agent_execution", "workflow_execution"]

@dataclass(frozen=True)
class RunRef:
    kind: RunKind
    id: UUID

@dataclass(frozen=True)
class AccessDecision:
    allowed: bool
    via: Literal["owner", "manager", "admin", "assigned", "grant", "scope", "none"]
    viewer_role: Literal["owner", "manager", "admin", "member"]
    reason: str | None = None            # human-readable when denied
    can_request: bool = False            # denied but may Request access

class AgentAccess:
    def __init__(self, db: AsyncSession) -> None: ...
    async def can(self, developer_id: UUID, principal_id: UUID,
                  action: AgentAction, *, run: RunRef | None = None) -> AccessDecision: ...
    async def require(self, developer_id: UUID, principal_id: UUID,
                      action: AgentAction, *, run: RunRef | None = None) -> AccessDecision:
        """403 {code:"access_required"|"forbidden", can_request} when denied."""
    async def visible_principal_ids(self, developer_id: UUID, workspace_id: UUID) -> set[UUID]: ...
    async def principal_for_run(self, run: RunRef) -> UUID: ...
```

`backend/src/aexy/services/agent_interventions.py` (access branch):

```python
async def record_intervention(db, *, principal_id: UUID, actor_id: UUID,
                              action: str, run: RunRef | None = None,
                              step_ref: str | None = None,
                              payload: dict | None = None) -> UUID: ...
```

`backend/src/aexy/services/run_events.py` (runs branch; the access branch
calls it, never edits it):

```python
async def publish_run_event(workspace_id: UUID, run: RunRef, event: dict) -> None:
    """Fire-and-forget Redis publish; never raises."""
```

`backend/src/aexy/services/platform_client.py` (access branch): an async
`PlatformClient` wrapping every C5 route, settings `PLATFORM_CONTROL_PLANE_URL`
and `PLATFORM_SERVICE_KEY` in `core/config.py`. Raises `PlatformUnavailable`
(502 to callers) and `PlatformError(status, body)`.

---

## C10. Aexy HTTP API — consumed by the frontend

All under `/api/v1/workspaces/{ws}`. `{pid}` = principal id.

### Access, sharing, log (access branch)

| Method & path | Body → response |
| --- | --- |
| `GET /agents/directory` | → `[AgentDirectoryEntry]` (only principals visible to me) |
| `GET /agents/principals/{pid}/access` | → `{can:{use,guide,configure,watch,control,view_thinking}, via, viewer_role}` |
| `GET/PUT /agents/principals/{pid}/sharing` | `{scope:"personal"\|"team"\|"org", team_ids:[]}` |
| `GET /agents/principals/{pid}/members` | → `[{developer_id,name,avatar_url,role}]` |
| `POST /agents/principals/{pid}/members` | `{developer_id, role:"manager"}` |
| `DELETE /agents/principals/{pid}/members/{developer_id}` | |
| `POST /agents/principals/{pid}/transfer` | `{developer_id}` |
| `POST /agents/principals/{pid}/access-requests` | `{mode:"watch"\|"control", run_kind?, run_id?, reason}` → `AccessRequest` (self-approved immediately when allowed: owner/admin) |
| `GET /agents/principals/{pid}/access-requests?status=pending` | → `[AccessRequest]` |
| `GET /agents/access-requests/mine-to-decide` | → `[AccessRequest]` across agents |
| `POST /agents/access-requests/{id}/decide` | `{decision:"approve"\|"decline", duration:"run"\|"1h"\|"1d"\|"1w"\|"standing"}` |
| `GET /agents/principals/{pid}/grants` · `DELETE …/grants/{id}` | |
| `GET /agents/principals/{pid}/interventions?actor_id=&run_kind=&run_id=&cursor=` | → `{items:[Intervention], next_cursor}` |
| `GET/PUT /agent-settings` | `{admin_personal_access:"notify"\|"require_owner_approval"}` |

### Live and control (access branch)

| Method & path | Body → response |
| --- | --- |
| `POST /agents/principals/{pid}/live-sessions` | `{mode:"watch"\|"control"\|"chat", run_kind?, run_id?, conversation_id?}` → `{live_session_id, url, token, expires_in, viewer_role, pod_state}`; 403 `{code:"access_required", can_request}` |
| `POST /agents/live-sessions/{id}/end` | |
| `POST /runs/{kind}/{id}/control` | `{command, text?, note?, outcome?, takeover_id?, domain?, save_password?, save_session?}` → `{state, signin_candidates?}` |
| `GET /runs/pod_claim/{id}/snapshot` | → `image/jpeg` \| 204 (cached 5 s) |

For `agent_execution` and `workflow_execution`, `pause|resume|stop|instruct`
are honoured by Aexy itself at the next step boundary; `acquire_control`,
`release_control`, `signin_decision` → 422.

### Virtual employees (access branch)

| Method & path | |
| --- | --- |
| `POST /agents/hosted` | wizard payload (C5 hatch body + `{sharing:{scope,team_ids}, managers:[developer_id], policy:{budget_seconds_per_card, unattended_questions:"park"\|"proceed"\|"fail", help_assignee_id?}}`) → `{principal_id, assistant}` |
| `GET /agents/hosted/{pid}` · `PATCH` | assistant JSON (C5) + `principal_id` |
| `POST /agents/hosted/{pid}/{restart\|resize\|upgrade\|rollback\|retire}` | |
| `GET /agents/hosted/{pid}/usage` | |
| `GET/PUT/DELETE /agents/hosted/{pid}/credentials[/{name}]` | |
| `GET /agents/hosted/{pid}/signins` · `DELETE …/signins/{domain}` | |
| `GET /agents/hosted/{pid}/threads?user=mine\|all` | `all` only for owner/manager/admin; logs `view_thread` when one is opened |
| `POST /agents/hosted/{pid}/chat/messages` | `{conversation_id?, text}` → `{conversation_id}` |

### Runs (runs branch)

| Method & path | |
| --- | --- |
| `GET /runs?status=active\|recent&kind=&principal_id=` | → `[RunSummary]` |
| `GET /runs/{kind}/{id}` | → `{summary: RunSummary, events: [RunEvent]}` (persisted history) |
| `GET /runs/{kind}/{id}/events` | SSE: `event: run_event` / `data: RunEvent`; `event: summary` / `data: RunSummary` on status change; keep-alive comment every 15 s |
| `GET /agents/live/needs-you` | → `[NeedsYouItem]` for me: open questions + takeovers routed to me + my pending approvals + access requests I decide |

### Shapes

```ts
type RunKind = "pod_claim" | "agent_execution" | "workflow_execution";
type AgentKind = "aexy_agent" | "virtual_employee" | "workflow";

interface AgentDirectoryEntry {
  principal_id: string; kind: "aexy_agent" | "virtual_employee";
  name: string; handle: string | null; avatar_url: string | null;
  crm_agent_id: string | null; assistant_id: string | null;
  owner: { id: string; name: string } | null;
  scope: "personal" | "team" | "org";
  status: "working" | "idle" | "asleep" | "stuck" | "provisioning" | "failed" | "disabled";
  current_run: { kind: RunKind; id: string; title: string } | null;
  my_access: { use: boolean; guide: boolean; configure: boolean; watch: boolean; control: boolean };
}

interface RunSummary {
  kind: RunKind; id: string; workspace_id: string;
  agent: { principal_id: string | null; name: string; kind: AgentKind; avatar_url: string | null; handle: string | null };
  title: string;
  subject: { type: "task" | "trigger" | "automation" | "chat"; id: string | null; label: string; url: string | null };
  status: "running" | "paused" | "blocked" | "awaiting_human" | "completed" | "failed" | "stopped" | "released";
  started_at: string; ended_at: string | null;
  budget: { seconds_used: number; seconds_limit: number | null; spend_cents: number; spend_limit_cents: number | null } | null;
  activity: { phase: string; text: string | null } | null;
  live: { available: boolean; conversation_id: string | null; assistant_id: string | null };
  control: { paused: boolean; paused_by: { id: string; name: string } | null; holder: { id: string; name: string } | null };
}

interface RunEvent {
  id: string; run_kind: RunKind; run_id: string; seq: number; at: string;
  type: "status" | "step" | "thinking" | "tool_call" | "tool_result" | "message"
      | "note" | "question" | "approval" | "takeover" | "intervention" | "error";
  title: string;
  detail: Record<string, unknown> | null;
  actor: { kind: "agent" | "person" | "system"; id: string | null; name: string } | null;
  step_ref: string | null;
  image_url: string | null;
}

interface Intervention {
  id: string; principal_id: string; run_kind: RunKind | null; run_id: string | null;
  step_ref: string | null; actor: { id: string; name: string; avatar_url: string | null };
  action: "instruct" | "pause" | "resume" | "stop" | "answer" | "takeover_started" | "takeover_ended"
        | "access_requested" | "access_granted" | "access_declined" | "access_revoked"
        | "signin_saved" | "signin_declined" | "signin_removed" | "settings_changed"
        | "sharing_changed" | "member_added" | "member_removed" | "ownership_transferred"
        | "view_thread" | "comment";
  payload: Record<string, unknown>; created_at: string;
}

interface AccessRequest {
  id: string; principal_id: string; agent_name: string;
  requester: { id: string; name: string; avatar_url: string | null };
  mode: "watch" | "control"; run_kind: RunKind | null; run_id: string | null;
  reason: string; status: "pending" | "approved" | "declined" | "cancelled";
  decided_by: { id: string; name: string } | null; decided_at: string | null; created_at: string;
}

interface NeedsYouItem {
  kind: "question" | "takeover" | "approval" | "access_request";
  id: string; agent: { principal_id: string | null; name: string; avatar_url: string | null };
  title: string; created_at: string; deadline_at: string | null;
  run: { kind: RunKind; id: string } | null; url: string; thumbnail_url: string | null;
}
```

## C11. Aexy frontend — module ownership

| Module | Owner branch | Others |
| --- | --- | --- |
| `frontend/src/components/runs/*` (`RunViewer`, `RunTimeline`, `ScreenPane`, `DesktopPane`, `EntityPane`, `CanvasPane`, `RunControls`, `RequestAccessPanel`) | runs-ui | import only |
| `frontend/src/hooks/useLiveSession.ts`, `useRunEvents.ts`, `useRuns.ts` | runs-ui | import only |
| `frontend/src/lib/runs-api.ts`, `lib/live-api.ts` | runs-ui | import only |
| `frontend/src/app/(app)/agents/live/*`, `/requests` takeover card | runs-ui | |
| `frontend/src/lib/agent-access-api.ts`, `lib/hosted-agents-api.ts` | agents-ui | import only |
| Agents list, `new/` kind picker + virtual-employee wizard, `[agentId]` tab shell and every tab except **Live**, sharing/access UI, sign-ins, log, `settings/agents` policy | agents-ui | |
| **Live** tab content | agents-ui renders `<RunViewer principalId run />` from runs-ui | |
| `messages/{en,hi}/runs.json` | runs-ui | |
| `messages/{en,hi}/virtualEmployees.json`, `agentAccess.json` | agents-ui | |
| `sidebarLayouts.ts` (adds `/agents/live`) | runs-ui | |

`RunViewer` props (stable, stubbed on the base branch):

```ts
interface RunViewerProps {
  workspaceId: string;
  run: { kind: RunKind; id: string } | null;   // null → the principal's current run, else empty state
  principalId?: string;
  initialMode?: "watch" | "drive";
  variant?: "page" | "sheet" | "tile";
}
```
