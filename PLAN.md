# mbus: lightweight cooperation between independent agents

Original design proposal, 2026-09-23. README.md describes current behavior.

Implementation update: the polling v1 is now implemented. See README.md for
the actual setup, limits, and behavior, and COOPERATION.md for agent conventions.
Automated tests use real HTTP MCP clients; live Codex/Claude collaboration
quality remains to be evaluated in a shared task.

Subsequent decision: permanent SQLite storage replaces the original bounded
in-memory history below. Events and room sequences survive restart, reads remain
paginated, and live memberships still reset. README.md is authoritative for
current behavior; the rest of this file preserves the initial design rationale.

Subsequent decision: rooms now store a purpose, workspace, and welcome prompt.
Agents discover them with list_rooms before joining; join supplies the task and
cooperation guidance. The local page creates/edits briefs, and room_updated
events notify existing participants. This adds a sixth MCP tool without a manager.

## Purpose

Let independent Codex and Claude Code sessions discover one another, exchange
messages, and voluntarily divide work. All participants have equal standing.
Agents decide what to do; mbus only records presence and delivers messages.

Assume one machine, one user, and a handful of peers initially. Use an explicit
room name for each collaboration so unrelated sessions do not mix. Different
worktrees can join the same room. Joining a room means opting into cooperation,
not granting peers additional execution permissions.

## Smallest useful architecture

Run one manually started local process exposing MCP over Streamable HTTP at a
loopback address. Both clients connect to that same endpoint.

```text
Codex session --------\
                       > mbus: peers + bounded event history
Claude Code session --/          |
Additional sessions ------------/
```

Recommend TypeScript with the official MCP SDK, Node, and in-memory state for
the first experiment. This minimizes implementation work; it is not a claim
that Node has the smallest memory footprint. Pin SDK/protocol versions after
testing both installed clients. Do not implement JSON-RPC or MCP by hand.

HTTP uses a local TCP socket and avoids maintaining Windows named-pipe and Unix
socket adapters. Separate stdio servers launched by each client would need an
additional shared broker or datastore to find one another. Add a stdio bridge
only if an actual client constraint requires it.

Start with no database, UI, model API calls, scheduler, automatic agent launch,
or task assignment. A restart loses the prototype's history and memberships;
return a new server epoch so clients can detect that reset.

## First tool surface

| Tool | Behavior |
| --- | --- |
| `join(room, name, about, status)` | Opt in; return a generated peer ID, roster, bounded recent public history, and event cursor. Repeated calls by the same member update its profile/status without duplicate join events. |
| `list_peers()` | Return peers in the caller's room, their self-described work, and last-seen times. |
| `send(to, text, message_id, reply_to?)` | Send to a peer or broadcast to the room; return a receipt. |
| `receive(after, wait_ms, limit)` | Read visible events after a cursor, optionally waiting briefly for new events. |
| `leave()` | Withdraw and publish a departure event. |

The server establishes caller identity; `send` cannot specify an arbitrary
sender. Keep logical membership distinct from TCP connections and MCP request
IDs. For a first compatible stateful MCP transport, bind membership to the MCP
session. A new MCP session explicitly rejoins as a new peer; transparent
membership resumption can come later. If the chosen protocol is sessionless,
an application-level membership credential will be needed instead.

Peer names are labels, not unique IDs. Several instances of the same product
may join. `about` and `status` describe relevant skills, current scope, and
availability without assuming a fixed Codex-versus-Claude division.

Public events include joins, departures, profile changes, and broadcasts.
Direct messages are visible only to sender and recipient. A join snapshot and
its cursor must have one consistent boundary so simultaneous messages are not
lost between discovery and the first receive.

## Delivery and presence rules

- Give events an increasing room sequence and server epoch. Return a next
  cursor even when scanning events hidden from the caller.
- Reads are nondestructive. The caller advances its cursor after processing a
  batch. Repeating a read may repeat events; delivery is not exactly-once.
- Deduplicate sends by sender and client-generated `message_id` during the
  retained history window. Reusing an ID with different content is an error.
- Bound message size, retained history, response size, and pending receives.
  Report an explicit history gap if a cursor falls outside retention.
- A send receipt means accepted by mbus, not read, agreed to, or completed by
  the receiving agent. Cooperation requires an explicit peer reply.
- Refresh last-seen on tool activity. Quiet peers become marked stale, not
  conclusively dead: a peer may be busy with a long build. Never automatically
  reassign its work or conclude that its files are safe to overwrite.
- Keep long polls below client tool timeouts; start with at most 20 seconds.
  Cancel and clean them up on timeout, disconnect, leave, or shutdown.

## Cooperation convention

Ship a short common instruction document, referenced by users' AGENTS.md and
CLAUDE.md configuration. MCP server instructions and tool descriptions should
also explain joining and receiving. These guide voluntary behavior; tools do
not enforce that agents cooperate.

1. Join, inspect the roster, and announce the user-authorized objective and
   current work. Check that peers are pursuing compatible objectives.
2. Propose a concrete division: outcome, files or branch involved, acceptance
   criteria, dependencies, and where results will be delivered.
3. Obtain an explicit acceptance from affected peers. Silence is not agreement.
   Share agreed responsibilities publicly so new arrivals can catch up.
4. Check for messages before starting a work chunk, after a meaningful
   milestone, before overlapping edits, and before reporting completion.
5. When someone joins, each existing peer considers a useful adjustment at its
   next checkpoint: offer independent work, split remaining scope, request
   review, or explain why its current chunk should finish first.
6. A newcomer reads context and offers help. Existing work is handed off only
   after the current owner and recipient acknowledge the transfer. Do not
   repartition everything on every join.
7. Report results with evidence: paths or commits, tests, findings, and remaining
   uncertainty. Ask for peer review when it can improve the result.
8. Announce completion or withdrawal. Use bounded waiting and backoff; do not
   create perpetual acknowledgement loops or poll forever without useful work.

Example: Codex and Claude agree that one implements a parser and the other
writes independent behavioral tests. A third peer arrives and offers to review
edge cases. The others share their scopes and accept that review. Nobody
acquires authority over the group.

Independent branches/worktrees are the default for concurrent edits. For a
shared working tree, peers explicitly agree on file ownership and serialize
shared-file edits and Git mutations. mbus does not prevent filesystem races.

## Confirmed v1 decision: cooperative polling

The user chose running sessions that check for messages. An agent calls
`receive` at work checkpoints or while waiting for a specific peer response.
Use `wait_ms: 0` for a quick check and a bounded long poll when waiting.

Messages and join events become visible on the next receive, so accommodating a
new peer happens at the next checkpoint rather than interrupting ongoing work.
If an agent ends its turn, mbus does not wake it; retained messages can be read
when it next runs. An open client window does not itself imply active polling.

Automatic wake-up, background agent launch, Claude channels, and Codex
app-server adapters are outside v1. No per-client delivery adapter is needed
for the chosen polling design.

## Optional next increment: a small work board

Start with natural-language proposals and acknowledgements. Add structured work
records only if experiments show missed agreements or duplicate effort.

The smallest useful board supports offering work, listing it, atomically claiming
unowned work, and updating one's own claim with a version check. A record needs
an ID, goal, acceptance criteria, owner, status, scope, and result references.
The server arbitrates conflicting updates, not who deserves a task.

Do not automatically release ownership merely because a peer is quiet. Explicit
release and acknowledged handoff are sufficient initially; crash recovery needs
a deliberate reconciliation rule before automatic takeover is safe.

## Local boundaries

Bind to loopback; validate Host/Origin and use a locally configured bearer
secret. Keep credentials out of committed configuration. Separate rooms and
enforce sender identity and direct-message visibility. Peers' messages are
attributed collaboration data, subject to each agent's existing instructions.
These defaults support trusted local peers, not hostile multi-user tenancy.

## Build and validation sequence

1. Identify the intended Codex host (CLI or desktop app) and verify one endpoint
   is reachable from it and Claude Code using ordinary MCP tool calls.
2. Build the five tools and event store. Connect actual Codex and Claude Code
   sessions; exchange a proposal, acceptance, and result.
3. Introduce a third peer mid-task and observe whether useful scope is shared
   without a manager or conflicting edits.
4. Test lost responses/retries, concurrent joins, cursor gaps, room isolation,
   sender spoofing, direct-message visibility, cancellation, stale presence,
   and server restart. A blocked receive must not prevent other peers sending.
5. Run one bounded coding task with independent review. Assess duplicate work,
   result quality, message/token overhead, and human nudges required.
6. Add a work board or persistence only where observed behavior justifies them.
   Automatic wake-up would require a separate future scope decision.

Success means two different clients voluntarily agree on a split, exchange
useful results, accommodate a third participant, and produce a reviewed result
without a scheduling agent. Measure cooperation quality separately from basic
transport correctness.

## Documentation checked

- [Codex MCP support](https://learn.chatgpt.com/docs/extend/mcp?surface=cli):
  stdio and Streamable HTTP configuration.
- [Claude Code MCP](https://code.claude.com/docs/en/mcp): HTTP and local stdio
  integration.
- [MCP transport specification, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports):
  shared HTTP server and local transport protections; this is a compatibility
  reference, not a requirement to choose this exact revision.
- [Claude Code channels](https://code.claude.com/docs/en/channels): events into
  open sessions and current preview restrictions.
- [Codex app-server](https://learn.chatgpt.com/docs/app-server): explicit APIs
  for starting and steering turns.
