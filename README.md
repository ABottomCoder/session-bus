# session-bus

Messaging between local Claude Code sessions.

You're deep in one session and you want another one to pick up the result. Instead of copying
text between terminals, you just say it:

> **send the conclusion to the review session**

It arrives in that session — **not typed into its input box**, so it's never confused with
something you wrote. The other session sees who it came from and can reply.

```
you ──▶ session A ──session_send──▶ [inbox keyed by session id] ──socket signal──▶ session B
                                                                                      │
                                                    arrives as an MCP tool result  ◀───┘
                                                    or as end-of-turn hook context
```

## Install

```bash
claude plugin marketplace add <repo-url>
claude plugin install session-bus@session-bus
```

Then **restart** each session you want on the bus (MCP servers only attach at session start —
`claude --resume` is fine and keeps the session's identity and inbox).

Requirements: **Node 18+**. That's it — zero dependencies, no `npm install`, no build, no
launch flags, no admin or org configuration.

## Using it

Four tools, but you shouldn't need to name them — just talk:

| You say | What happens |
|---|---|
| "what sessions are running?" | `sessions_list` — labels, ids, unread counts |
| "send this conclusion to message_test" | `session_send` — delivered, plus a reply address |
| "wait for the plan from session A, then implement it" | `session_wait` — blocks on an event, wakes in ~25ms |
| "check my inbox" | `session_inbox` — reads and marks read |

### A worked example

In session A, after you've settled a design:

> send session B the final schema decision and tell it to start the migration

In session B — if you'd told it to wait, it wakes immediately and starts. If it was working on
something else, the message lands at the end of its current turn. Either way B knows the
message came from a peer session, not from you, and will check with you before doing anything
destructive.

## How delivery works (and the one thing it can't do)

| Receiver state | How it arrives | Speed | Do you need to do anything? |
|---|---|---|---|
| Waiting on `session_wait` | socket event → tool result | **~25ms measured** | No |
| Working (mid-turn) | Stop hook → end-of-turn context | end of turn | No |
| Idle, **channels available** | pushed straight in as a channel event | immediate | No |
| Idle, no channels | macOS notification + terminal bell | — | **Say anything to it** |

There is **no polling anywhere** in the delivery path.

### Channels: the best case, when you can get it

If a session is started with `--channels`, session-bus pushes messages **straight into it even
while it sits idle** — nothing to type, nothing to notice. That is the ideal, and it is used
automatically wherever it works.

It is not always available:

- **Amazon Bedrock**: not supported. Verified — pushes are silently dropped.
- **`--channels` is a per-session launch flag**, and `claude --resume` does not restore flags,
  so each session has to opt in every time it starts.
- **Research preview**: custom channels are off Anthropic's allowlist, so you need
  `--dangerously-load-development-channels`, or an admin setting `allowedChannelPlugins`.

To try it:

```bash
claude --dangerously-load-development-channels plugin:session-bus@session-bus
```

Run `sessions_list` and check the reported idle-delivery mode. If it says `channel push`,
you're set. If it says `notify-the-human when idle`, it tells you exactly why.

**Where channels don't work, nothing breaks** — delivery falls back to the other three paths,
and the last row above applies: type anything and the message lands at the end of that turn.
Because a channel push is never acknowledged by Claude Code, session-bus also double-checks:
if a pushed message hasn't been picked up within ~25 seconds, you get the notification anyway.

## Inbox lifetime

- One inbox per session, keyed by session id. **Messages never expire** — an unread message
  waits indefinitely for its session to come back.
- `claude --resume` keeps the same session id, so **unread messages survive a restart**.
  (`--resume --fork-session` starts a new identity with an empty inbox.)
- Messages disclose their age, so one that waited three days shows as
  `(3d old — sent while this session was closed)` instead of reading as current.
- An inbox is deleted only when its session truly no longer exists — not running **and** no
  transcript left on disk. Closing a session does not lose its messages.

## Duplicate names

Terminal titles collide, and Claude Code renames tabs as it works. Routing therefore uses the
session id, not the title. If you say "send it to review" and two sessions match, the send is
**refused** and you're asked which one you meant — it will not guess. You can always address a
session by its id, which `sessions_list` shows.

Renames are picked up live: labels are re-read from the current terminal titles every time
sessions are listed or a target is resolved, so a session renamed with `/rename` is reachable
by its new name immediately. A label set explicitly via `SESSION_BUS_LABEL` is pinned and
never overridden.

## Security

The bus never leaves your machine, and everything in `~/.claude/session-bus/` is created
`0700`/`0600` — other users on the machine can't read your messages or poke your sockets.

Messages from peer sessions are treated as **untrusted data**: every body line is rendered
quoted (`> `), stripped of ANSI/control characters, and followed by a notice telling the
receiving model that the sender identity is claimed rather than authenticated and that
destructive or outward-facing actions still need your confirmation. A message that tries to
fake a system notice or your approval renders as visibly quoted text. Bodies are also capped
(64k stored / 16k rendered) so a peer can't blow out a session's context.

The honest limit: anything running **as your own user** can write to the bus and claim any
sender name — the same boundary as `~/.ssh`. Session-bus makes that visible instead of
pretending to authenticate peers.

## Config

| Env var | Effect |
|---|---|
| `SESSION_BUS_LABEL` | Set this session's human-facing label (default: terminal title) |
| `SESSION_BUS_BELL=0` | Suppress the terminal bell on incoming messages |
| `SESSION_BUS_ELICIT=1` | Also raise an in-session dialog when idle (experimental, unverified) |
| `SESSION_BUS_FORCE_CHANNEL=1` | Use the channel path even if detection says it's unavailable |
| `SESSION_BUS_NO_CHANNEL=1` | Never use the channel path |
| `SESSION_BUS_CHANNEL_VERIFY_MS` | How long to wait for a push to be picked up before notifying you (default 25000) |

## Turning it off

Three levels, depending on how thorough you want to be.

**Pause it** — keeps everything installed, one command to bring it back:

```bash
claude plugin disable session-bus     # later: claude plugin enable session-bus
```

**Remove it completely:**

```bash
claude plugin uninstall session-bus            # the plugin and its cached copy
claude plugin marketplace remove session-bus   # the marketplace registration
rm -rf ~/.claude/session-bus                   # optional: inboxes, cursors, sockets
```

Skip the last line to keep unread message history for a future reinstall.

**Exclude a single session** — there's no per-session opt-out flag. A session that has the
plugin will still *receive* messages, which is usually what you want. If you truly need one
excluded, disable it globally.

Two things to know:

- **Already-running sessions keep working until they restart.** Disabling or uninstalling only
  affects newly started sessions; an existing one attached its MCP server and Stop hook at
  launch.
- **Uninstalling does not delete `~/.claude/session-bus/`.** Remove it by hand if you want a
  clean slate.

There is not much reason to turn it off for cost: `claude plugin details session-bus` reports
`Always-on: ~0 tok`. The Stop hook is a shell-level check that never enters the model's context
and is silent on an empty inbox; tool schemas are resolved at runtime. The only real overhead is
one idle Node process per session.

## Troubleshooting

**"No live session matches X"** — the target hasn't been restarted since the plugin was
installed, so it isn't on the bus. Restart it (`claude --resume` keeps its history).

**A session isn't listed** — run `node bin/bus.mjs list`. If it's absent, that session has no
`session-bus` MCP server; check `/mcp` inside it.

**Messages arrive but nothing happens when idle** — expected unless channels are active. Run
`sessions_list` in that session: it reports the idle-delivery mode and, if it's falling back,
the reason. Otherwise just say anything to that session and the message lands at the end of
that turn.

**No notification appears** — the call can succeed while macOS suppresses the banner (Do Not
Disturb, or notifications disabled for your terminal). Check System Settings → Notifications.

**You edited the code and nothing changed** — installing creates a *cached copy*, and
`claude plugin update` only refreshes it if the version number changed. Reinstall instead:
`claude plugin uninstall session-bus && claude plugin install session-bus@session-bus`, then
restart the session.

## Development

```bash
node test/smoke.mjs          # 55 checks against real servers, real JSON-RPC, real sockets
claude plugin validate .     # manifest check
claude --plugin-dir "$PWD"   # load into one session only, without a global install
```

Architecture, design invariants, the record of what was already ruled out, and the publishing
checklist are in [CLAUDE.md](CLAUDE.md). Read that before changing anything.

## Layout

```
lib/bus.mjs             identity, inbox, socket signalling, sweep, rendering
mcp/server.mjs          MCP server: 4 tools, socket listener, no polling
hooks/stop-pickup.mjs   Stop hook: end-of-turn delivery, fail-open
bin/bus.mjs             CLI: list / send / inbox / whoami / sweep
test/smoke.mjs          55-check smoke suite
```
