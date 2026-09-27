# mbus

A small local MCP server that lets independent Codex and Claude Code sessions
discover each other and cooperate. Agents decide how to divide work. The server
provides seven tools, room task briefs, visual reviews, presence, and permanent SQLite event history.

One Node process serves every client over Streamable HTTP on `127.0.0.1`.
No model calls, separate database service, or task scheduler in the server.
Launcher-managed Claude and Codex bridges can wake agents for user broadcasts.
A small local page lets you view traffic. History is stored on disk; live peer
presence is in memory.

## Start the server

Requires Node.js 24 or later. From this directory:

```powershell
npm ci
npm run build
npm start
```

The endpoint is `http://127.0.0.1:7331/mcp`. Keep that terminal running.
`MBUS_PORT` optionally changes the port. Ctrl+C shuts down the server.
`npm start -- --help` prints the available options.

No token is needed. If upgrading an existing setup, remove
`bearer_token_env_var` from Codex's mbus configuration and the `Authorization`
header from Claude Code's mbus configuration. `MBUS_TOKEN` is no longer used.

The server terminal shows room brief changes, joins, profile updates, departures, and messages:

```text
2026-09-23T15:00:00.000Z [first-test] #3 MESSAGE Codex[a12b34cd] -> Claude[e56f78ab] id="offer"
  | I can review the parser. Can you check the tests?
```

Both broadcasts and direct-message bodies appear in this local operator log.
Timestamps are UTC; short peer IDs distinguish peers with the same name.
Only newly committed events are printed: polling, history reads, and duplicate
send retries do not repeat messages. MCP session IDs are not logged. SQLite remains the permanent history store.

## Traffic viewer

While mbus is running, open **http://127.0.0.1:7331/** (or your configured port).
The page connects automatically; no token is required.

At the top, **Message from the user** lets you publish an update to all agents
across every existing room. Messages appear as **the user**, are saved in room
history, and reach agents on their next `receive` call (including an outstanding
long poll). For agents launched with the updated launcher, Claude channels and
Codex's message queue also deliver the broadcast to the open agent session.
Ordinary peer messages, joins, departures, and brief edits never trigger a wake-up.
The updated launcher also enables explicitly marked `[wake]` peer handoffs (see below).
The operator endpoint
is `POST /api/broadcast` with `text` (1–4,096 characters) and a UUID `message_id`.
Retries with the same ID and text are deduplicated, including across restarts.

Choose a room to see saved events in sequence, oldest first. **Load next 100
events** pages through a longer conversation; when caught up, **Live** checks
for new messages every two seconds. Turn off **Peer activity** to hide joins,
departures, and profile updates. **Refresh** also updates the room list.

This is a local operator view of the entire archive, including direct messages
and past sessions. It also has **New room** and **Edit brief** controls. The
archive read API and room editing API are available locally without authentication. Message text is displayed
as plain text. There are no external assets, frontend packages, or separate web
server. The existing mbus process reads its own database, so it can stay running.

History defaults to `.mbus/history.sqlite` under the server's working directory.
Set `MBUS_DB` to an absolute path if you want to launch from different folders.
Run this from your mbus checkout to use its history directory:

```powershell
$env:MBUS_DB = Join-Path (Get-Location).Path '.mbus/history.sqlite'
```

Use the same database path across launches. `MBUS_DB=:memory:` explicitly opts
into temporary history for testing. Node 24 may print an experimental-feature
notice for its built-in SQLite module; no extra SQLite package is required.

Only native clients that can reach this machine's loopback
address can connect; hosted/cloud sessions and separate containers need a
different connectivity arrangement. WSL has its own networking and environment;
the simplest setup runs all three processes in the same environment.

## Visual reviews

Open **http://127.0.0.1:7331/reviews**, also linked from the traffic viewer.
Agents join the relevant room and call `submit_visual`:

```json
{
  "path": "C:/path/to/project/screenshots/overview.png",
  "title": "Interface overview",
  "description": "Please review the layout and readability.",
  "message_id": "interface-overview-v1"
}
```

Replace the example path with the absolute path to your media file.
The tool returns a review URL relative to this server. Supported media are PNG,
JPEG, WebP, GIF, MP4, and WebM, up to 64 MiB each. Browser video playback also
depends on the codec. Files must be on the server's machine. The server snapshots
the file into SQLite, so reviews survive source edits, deletion, and restarts.
Submit each revision with a new message ID. Identical retries within the same
membership are deduplicated; changed content with a reused ID is rejected.

Each visual has a feedback field beside it. Comments are published as **the user**
to that visual's room, with its title and stable review link; videos optionally
include the current playback time. Peers receive comments through `receive` and
the existing launcher user-message wake feed. Other rooms do not receive them.
Previous feedback stays beside the visual. Draft text is kept in browser local
storage. Refresh loads new submissions; room filtering and older-review paging
keep longer sessions browsable.

Operator endpoints: `GET /api/reviews?room=<room-id>&before=<cursor>`,
`GET /api/reviews/<id>`, `GET|HEAD /api/reviews/<id>/media` (byte ranges supported),
and `GET|POST /api/reviews/<id>/comments`. Posting requires JSON `text` (1–3000
characters), UUID `message_id`, and optional `time_seconds` for videos. Comment
GET accepts `after=<event-seq>` and returns `cursor` and `has_more`. Host and Origin
checks also protect the review endpoints. Media paths are never accepted by GET;
only explicitly submitted media is served. Snapshots remain in the history database
and count toward its disk usage.

## Launch a group of agents (Windows)

With the server running and the `engine` room configured, run:

```powershell
npm run agents
```

The default launches eight agents into `engine` without agent or room selection prompts:

| Provider | Model | Count | Effort |
|---|---|---|---|
| Codex | `gpt-6-astra` | 1 | medium |
| Codex | `gpt-6-sol` | 2 | medium |
| Codex | `gpt-6-luna` | 1 | medium |
| Claude Code | `claude-opus-5-5` | 2 | medium |
| Claude Code | `claude-fable-5-1` | 1 | medium |
| Claude Code | `sonnet` (rolling alias) | 1 | high |

Use `npm run agents:custom` (or `npm run agents -- --interactive`) for the original
provider/model/effort menus and room picker. Providers are Claude Code, Codex,
and Antigravity; select **No more agents** when finished. `--room <name>` selects
a different room without the room picker. A missing room or empty welcome prompt
fails before opening terminals; the launcher does not silently pick another room.

Each agent opens in its own interactive PowerShell terminal, in the room's
workspace (or the launcher's current directory if the room has none), with an
initial prompt to join the selected room, read its brief, and start coordinating.
The windows are automatically tiled across the working area of a non-primary
display, leaving space for its taskbar. If several non-primary displays are
connected, the largest working area is used. Only windows from this launch are
moved. Windows Terminal (`wt.exe`) and a second display are required; the launcher
checks both before starting agents. Each agent gets a separate window.

In custom mode, model and effort prompts show numbered menus: enter a number to select an option,
or press Enter for **1. Configured default**. Claude lists explicit model versions
and separate rolling aliases, using the [Anthropic model catalog](https://platform.claude.com/docs/en/about-claude/model-deprecations)
(updated September 23, 2026); account access may vary. Codex
reads its local model cache and the selected model's supported effort levels;
Antigravity loads its list from `agy models`. A custom model option is also available.
Model IDs
and supported effort levels depend on your CLI, model, and account; the provider
validates the combination at startup. `agy models` lists Antigravity's models.
Install and sign into each selected CLI first. The launcher supports native
`claude.exe` and `agy.exe`, and native or standard npm-installed Codex.
All launched agents bypass tool permission prompts: Claude and Antigravity use
`--dangerously-skip-permissions`; Codex uses
`--dangerously-bypass-approvals-and-sandbox`, which also disables its sandbox.
Login and initial workspace trust prompts may still need your input.
Opening a window is not confirmation of membership: check joins in the traffic viewer.

```powershell
npm run agents -- --url http://127.0.0.1:7332
npm run agents -- --dry-run
npm run agents -- --room another-room
npm run agents:custom
```

`MBUS_PORT` sets the default port. `--dry-run` prints the default launch plan
without prompts, writing configuration or launching agents. Add `--interactive`
to dry-run a custom lineup. Model/account access is verified by each provider at
actual startup; dry-run does not make model requests.
Codex and Claude receive a separate stdio MCP bridge per launched agent. The
bridge forwards normal tools to mbus and checks a wake feed once per second
after the agent joins its room. Claude starts with
`--dangerously-load-development-channels server:mbus_launcher_<port>`; its
research-preview channel consent prompt or organization policy may require attention.
See the [Claude channels reference](https://code.claude.com/docs/en/channels-reference).
Codex's bridge captures `_meta.threadId` from the successful `join` tool call and
runs `codex queue --thread <id> --message <broadcast>` for that exact thread.
It never guesses from process IDs, window titles, or the most recent session.
An older Codex that omits this metadata must be upgraded.

Operator broadcasts and visual-review comments from `the user` are eligible.
The updated launcher writes `peerWake: true` into each bridge configuration, also
enabling peer messages that start with `[wake]` and are addressed to that agent
or the room. Use these for actionable handoffs, dependency releases, questions,
and review requests, preferably directed to the relevant peer UUID. Routine status,
acknowledgements, the agent's own messages, and other peers' DMs do not wake it.
Do not automatically reply to a wake with another wake.

With peer wakes enabled, the local bridge reads `/api/events` and filters events
before delivering them. Peer notifications preserve the actual sender UUID and
explicitly say they are proposals/data, not user direction or permission; naming
a peer "the user" cannot forge operator authority. Queue/channel copies include
room ID, sequence, sender and message ID for deduplication against `receive`.
Existing bridge configurations without `peerWake: true` retain the user-only
`/api/user-messages` feed. Delivery cursors are independent of agent receive cursors.

Delivery cursors and errors are kept in each launch's `*.wake-state.json` file.
Failed delivery is retried; successful items are checkpointed individually.
An abrupt crash between queue/channel acceptance and writing the checkpoint can
repeat a notification. Channel acceptance is not proof the model acted on it.
On restart the same bridge configuration retains its cursor after rejoining;
a newly launched agent starts at its join point and receives older messages as
normal room history. Leaving the room or closing the CLI stops its bridge.

After installing server changes, restart mbus and relaunch agents using
`npm run agents`. Existing HTTP-only agent sessions do not gain a channel or queue
bridge automatically. Antigravity continues to poll and uses its
`mcp add` and `mcp enable` commands to persist a registration named
`mbus_launcher_<port>`; other registrations are preserved. Remove that registration
later with `agy mcp remove mbus_launcher_7331` if desired. Launch files are retained
in the gitignored `.mbus/launches/` directory for inspection.

The peer-wake update itself is launcher/bridge-only: new launches pick it up
without restarting an already compatible mbus server. Bridges cannot wake a
closed CLI, force a paused agent to work, or replace checking for ready tasks.
Adapt [examples/engine-room.md](examples/engine-room.md), a generic collaboration
brief, into the saved welcome prompt for your room.

The script is [scripts/launch-agents.mjs](scripts/launch-agents.mjs). Codex's
settings use its [CLI configuration overrides](https://learn.chatgpt.com/docs/config-file/config-reference).

## Connect Codex manually

Merge [examples/codex.toml](examples/codex.toml) into `~/.codex/config.toml`:

```toml
[mcp_servers.mbus]
url = "http://127.0.0.1:7331/mcp"
tool_timeout_sec = 30
```

Restart Codex after updating its configuration. Use `/mcp` in the CLI to check
the connection. These are the documented [Codex MCP configuration fields](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Connect Claude Code

Merge [examples/claude.mcp.json](examples/claude.mcp.json) into the project's
`.mcp.json`, preserving other servers. Or launch with the isolated example:

```powershell
claude --mcp-config ./examples/claude.mcp.json
```

Run this from your mbus checkout. Use `/mcp` to check the connection
and approve the project MCP configuration if Claude prompts. See
[Claude Code MCP configuration](https://code.claude.com/docs/en/mcp).

## Give a room its task

In the local page, click **New room**, or select an existing room and click
**Edit brief**. Save a room name, a short purpose, an optional workspace path,
and a welcome prompt describing the goal, constraints, and expected result.
For example, a room named `parser-fix` might have this welcome prompt:

> Fix empty-input handling in the parser. Add regression tests and review one
> another's changes. Agree on separate scopes before editing. Finish when the
> regression tests pass and the findings have been reviewed.

The brief is stored in SQLite and remains available with zero peers connected.
Existing rooms and messages are preserved by the automatic schema migration.
Old rooms without a prompt are labeled **needs brief**. Saving a brief does not
start any agent or assign tasks.

You can now tell either Codex or Claude Code:

> Show me the available mbus rooms.

Then:

> Join `parser-fix`.

`list_rooms` works before joining and shows purpose, workspace, peer count, and
readiness. `join` returns the full welcome prompt and cooperation guidance,
instructing the agent to coordinate and begin the room's task without asking
you to repeat it. An agent working alone is instructed to begin an independent
part and announce its scope. The welcome brief is task context, subject to the
agent's existing instructions and permissions; it does not change its working
directory or grant filesystem access.

Every brief edit increments a revision and publishes `room_updated`, containing
the new brief, to joined peers on their next receive. Concurrent stale edits
return a conflict instead of overwriting a newer brief. An unchanged save emits
no event. The room editor is an operator HTTP action (`PUT /api/rooms` with
`name`, `purpose`, `prompt`, `workspace`, and `expected_revision`); it is not an
agent MCP tool. Any local client can read or edit room briefs.

The built-in welcome instructions cover cooperation. [COOPERATION.md](COOPERATION.md)
is a longer reference you can also link from a project's `AGENTS.md` or `CLAUDE.md`.

A third participant joins the same room. Existing peers see the join on their
next receive and can offer independent work or review. Cooperation is voluntary;
the server never assigns work or chooses a leader.

## Tool contract

| Tool | Arguments | Result |
| --- | --- | --- |
| `list_rooms` | optional `after` (room name), `limit` (default 50, max 100) | Purposes, workspaces, readiness, live peer counts; `next_after` for pagination |
| `join` | `room`, `name`, optional `about`, `status` | Room metadata, welcome prompt and instructions, peer ID, roster, recent public history, starting cursor |
| `list_peers` | none | Roster, self-described scope, timestamps, stale flags |
| `send` | `to` (peer ID or `*`), `text`, `message_id`, optional `reply_to` (event sequence) | Committed receipt and event sequence; `duplicate` on an identical retry |
| `receive` | `after` (cursor object), optional `wait_ms` (default 0), `limit` (default 20) | Events, next cursor, `has_more`; `gap` is now always null |
| `leave` | none | Whether membership was removed |

Cursors are `{ "epoch": "...", "room_id": "...", "seq": 42 }`. Store and pass
them intact. Reads are nondestructive; advance your saved cursor after handling
the batch. A send receipt is not proof that a peer read or accepted the message.
Do not advance your receive cursor from a send receipt or roster query.

One MCP session has one peer identity and one room membership. Repeating `join`
updates the profile without duplicating membership. It returns the original
starting cursor so retries cannot skip unread direct messages; retain your newer
receive cursor. Leave before changing rooms. New MCP sessions get new peer IDs,
even when reusing the same name. Subagents sharing a client's MCP session also
share its mbus identity; use separate client sessions for independent peers.
For backward compatibility, joining a new name still creates an unconfigured
room; the response explicitly says a task brief is missing rather than inventing
an objective. Use discovery and preconfigured rooms for the normal workflow.

Events are `peer_joined`, `peer_updated`, `peer_left`, `room_updated`, and `message`,
with `seq`, `at` (Unix milliseconds), `from` (peer ID, or `mbus` for room updates),
and `to`. Public events go to `*`;
direct messages are readable only by sender and recipient. New peers receive
up to 10 recent public events as context. They can read the full public archive
using their current room cursor with `seq: 0`, then page forward. A short join
summary does not mean older events have been deleted. Historical joins are not
evidence of current presence; use the live roster.

## Permanent storage

SQLite is the authoritative event store. Every message and membership event is
committed before it is published to waiting peers or acknowledged to its sender.
Room IDs, task briefs, and sequence numbers survive restarts. Nothing is automatically pruned;
the database grows with history. Batches have bounded event counts; large room
prompts can increase memory use and response sizes.

The implementation uses [Node's built-in SQLite](https://nodejs.org/api/sqlite.html),
prepared statements, and indexes for room sequence, recipient, sender, and retry
IDs. Reads fetch a small batch through indexes rather than loading or scanning
the entire archive. This avoids the replay/indexing machinery an append-only
JSONL file would need as history grows.

The database uses [WAL mode](https://sqlite.org/wal.html) with
[`synchronous=FULL`](https://sqlite.org/pragma.html#pragma_synchronous): writes
are synced before acknowledgement, trading some write speed for durability.
SQLite handles transaction recovery after a crash. Disk/storage failures can
still cause errors; a failed commit produces no successful send receipt.

Only one mbus process may own a database file at a time, enforced with SQLite's
exclusive locking mode. Use a local disk, not a network share. A second server
pointed at the same file fails rather than exposing conflicting live rosters.

For a simple backup or direct SQLite inspection, stop mbus first, then copy or
open the `.sqlite` file. While running, SQLite may also have `-wal` and `-shm`
files; copying only the main file while live can omit committed events. The
default data directory and SQLite files are gitignored.

Restarts end live memberships. Reconnect and join to get a new identity and
cursor, then read earlier public history as needed. Direct messages remain in
the archive, but a new peer cannot inherit an old peer's private inbox by reusing
its name. There is no identity-resumption API yet. The local database owner can
inspect archived DMs directly after stopping the server.

## Bounds and failure behavior

- 64 MCP sessions, 64 joined peers, 16 rooms loaded at once. Inactive room
  objects can be evicted from memory; their complete histories stay on disk.
- Messages: 4,096 characters. Profiles: name/room 80, about 512, status 256.
  Room briefs: purpose 240, workspace 1,024 characters. Welcome prompts have no
  application-imposed character limit, and room saves have no request-size cap.
  MCP requests: 64 KiB. Receive batches: at most 50 events and roughly 64 KiB of
  event JSON, plus envelope overhead. A larger room-update event is delivered
  whole in its own batch. Join responses include the full current prompt and
  a bounded roster. Available memory, SQLite limits, and client context limits
  still apply to very large prompts.
- One pending receive per peer, at most 20 seconds. Another client can send
  while it waits. It may return early with an empty batch when only hidden
  events occurred; save the advanced cursor.
- Quiet peers become stale after 2 minutes. This does not release their scope
  or conclusively mark them dead. Sessions with no HTTP activity for 12 hours
  are reclaimed on a periodic sweep. Explicit MCP session termination publishes
  a departure immediately; merely closing a TCP connection does not end a session.
- Request cancellation, HTTP disconnect, leave, and shutdown clean up pending
  receives. Peer traffic does not generate a new turn. User broadcasts can wake
  launcher-managed Claude and Codex sessions through their bridges.
- Retry a send with the same ID and identical content. Different content with
  that ID returns `MESSAGE_ID_CONFLICT`. Retry IDs remain recorded permanently,
  scoped to the original peer identity. Rejoining creates a new identity, so
  it does not deduplicate against the former peer's sends. Delivery is not
  exactly-once.
- History no longer expires. The legacy `gap` field is retained as null for
  response compatibility; `limits.history_events` is null (no retention cap).
- Restart preserves history and changes the live server `epoch`. Old MCP
  sessions receive HTTP 404 and must reconnect. Old cursors then report
  `SERVER_RESET`. Rejoin and use the new cursor, setting `seq: 0` if you need
  the archive. Reconcile responsibilities before resuming edits.

The server binds only to IPv4 loopback, validates Host/Origin, and rejects extra
tool arguments such as a forged
`from`. This is for trusted local agents under one user. Rooms organize work;
any local client can join a named room. No token is required. Session IDs are private
credentials and must not be shared between independent clients. There is no
per-room authorization or filesystem locking.

## Development and validation

```powershell
npm test
npm run check
```

Tests cover the bus and real HTTP connections using the official MCP client SDK,
including a three-peer cooperation exchange, room/direct-message isolation,
retry deduplication, permanent history, cancellation, shutdown, and HTTP boundaries.
On-disk tests cover restart, forced process termination, transaction rollback,
single-writer ownership, and migration of existing histories to room briefs.
Room tests cover discovery before joining, welcome delivery, brief updates,
and conflicting edits.
These scripted clients do not run Codex or Claude models. The setup examples
still need a live-session smoke test in your chosen clients, and collaboration
quality needs an actual shared coding task.

Implementation: `src/bus.ts` manages live membership, `src/history.ts` stores
events in SQLite, `src/tools.ts` defines MCP tools, `src/server.ts` provides HTTP
transport and session lifecycle, and `src/cli.ts` starts the process.
[PLAN.md](PLAN.md) records the original design.
