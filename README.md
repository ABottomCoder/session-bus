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

**Step 1 — install the plugin** (once per machine):

```bash
claude plugin marketplace add ABottomCoder/session-bus
claude plugin install session-bus@session-bus
```

**Step 2 — restart every session you want on the bus.** This is not optional: MCP servers
only attach when a session starts, so sessions that are already running will not see the
bus until restarted. `claude --resume` is fine — it keeps the session's identity, history,
and inbox.

**Step 3 (recommended) — start receiver sessions with channels** for the best experience:

```bash
claude --dangerously-load-development-channels plugin:session-bus@session-bus
```

With this flag, messages are pushed **straight into the session even while it sits idle** —
nothing to type, nothing to notice. Without it everything still works, but an idle session
falls back to a macOS notification + bell, and the message lands only after you say
anything to it. The flag is per-launch (`--resume` does not restore it), it requires the
`--dangerously-load-development-channels` form because channels are a research-preview
feature, and it cannot be used from the desktop app — see
[Channels](#channels-the-best-case-when-you-can-get-it) for the details and caveats.

Requirements: **Node 18+**. That's it — zero dependencies, no `npm install`, no build, no
admin or org configuration. The core bus needs no launch flags; the flag above only
upgrades idle delivery.

### Making Step 3 short

That command is long because channels are a research preview: there is no env var and no
user-level settings.json equivalent for the flag (confirmed against the official settings
and CLI references — the only channel settings are org-managed). The supported shortening
is your shell. Add either (or both) to `~/.zshrc` / `~/.bashrc`:

```bash
# a short explicit command: `claude-bus`
alias claude-bus='claude --dangerously-load-development-channels plugin:session-bus@session-bus'

# OR: make bare `claude` (and resume) default to channel push.
# Only session-starting invocations are wrapped; `claude plugin ...`, `claude -p ...`
# and every other subcommand pass through untouched.
claude() {
  case "$1" in
    ''|-r|--resume|-c|--continue)
      command claude --dangerously-load-development-channels plugin:session-bus@session-bus "$@" ;;
    *)
      command claude "$@" ;;
  esac
}
```

Two caveats: the research-preview warning screen still appears on each launch that carries
the flag (acceptance is not documented as remembered), and the wrapper deliberately skips
invocations like `claude --model ...` — start those sessions with `claude-bus --model ...`
if you want channels there too. Delete the lines to revert.

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
| Idle, **watcher armed** (`bin/watch.mjs`) | background task exits → wakes the session | **~11s measured** (8s settle + watch latency) | No |
| Idle, nothing armed, no channels | macOS notification + terminal bell | — | **Say anything to it** |

There is **no polling anywhere** in the delivery path.

Two politeness guarantees on top: **notifications are coalesced** — you get one when mail
first arrives in an empty inbox, silence while it piles up, and at most one reminder per
5 minutes (configurable) — and **delivery is batched** (50 messages / 48k chars at a time,
the rest disclosed and kept unread), so a flood can neither spam your notification center
nor dump an entire backlog into a session's context at once.

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
- **Desktop app sessions can't opt in**: the desktop app launches sessions with its own
  fixed arguments and offers no way to add CLI flags (verified against the launch args, and
  the official docs' only recipe is "restart from a terminal with the flag"). Desktop
  sessions still send and receive normally — they just use the notification fallback when
  idle.

To try it:

```bash
claude --dangerously-load-development-channels plugin:session-bus@session-bus
```

Run `sessions_list` and check the reported idle-delivery mode. If it says `channel push`,
you're set. If it says `notify-the-human when idle`, it tells you exactly why.

**Where channels don't work, nothing breaks** — delivery falls back to the other paths, and the
last row above applies: type anything and the message lands at the end of that turn.
Because a channel push is never acknowledged by Claude Code, session-bus also double-checks:
if a pushed message hasn't been picked up within ~25 seconds, you get the notification anyway.

### Watcher: autonomous pickup where channels don't work

If channels are unavailable (Bedrock, the desktop app, or an org that blocks the flag), a
session can still pick mail up on its own — no channel, nothing typed. Ask it to arm the
watcher, and it will keep the loop going by itself:

> arm the session-bus watcher, then go idle

Under the hood it runs this as a **background** task and returns to your prompt straight away:

```bash
node bin/watch.mjs --sid <its-own-sid> --timeout-s 1800 --settle-ms 8000
```

The trick is that Claude Code re-invokes a session when a background task **exits** — and that
wake reaches a session sitting idle. So a process that blocks until there is genuinely unread
mail, then exits, supplies the wake that channels would otherwise provide. On wake the session
drains `session_inbox` and re-arms.

Why this is better than `session_wait` for the same job: `session_wait` blocks the session's
turn, so **you** can't talk to it while it waits. The watcher lives outside the turn, so the
session stays responsive to you and to its peers at the same time.

**You can see whether a session is listening.** `sessions_list` reports `idle-pickup=armed` or
`NOT armed` for every peer, and `session_send` tells the sender which it got — when the target
isn't armed it says so and warns against reporting the message as received. That matters at the end
of a collaboration: if one side stops re-arming and the other keeps sending, the message is still
stored durably and you still get a notification, but nothing will act on it until you say something
to that session. Without the disclosure, a sending session can mistake "delivered" for "read".

Four behaviours worth knowing:

- **An expiry is honest, not a failure.** After `--timeout-s` with no mail it wakes once and
  says nothing arrived. Size the timeout to how long you actually expect to wait; every expiry
  costs one cheap turn.
- **Don't arm two watchers on one session.** You'd get two wakes for one message. `session_send`
  warns when it sees more than one armed, so if you see that warning something is re-arming without
  checking first. Nothing is lost either way.
- **A killed watcher says so.** If something kills it, it reports that the session is no longer
  armed and exits non-zero, rather than leaving a session that looks armed but is deaf. To stop
  one deliberately, use `TaskStop` with its task id — a broad `pkill -f` will also kill the
  watchers of *other* sessions on the machine.
- **When you're done, wind down with a drain window.** Don't disarm the instant you send a final
  message; re-arm once with a short timeout (e.g. `--timeout-s 120`) and stop after it expires with
  an empty inbox. Nothing can make this airtight — that's the Two Generals' Problem — but combined
  with the durable inbox and the `NOT armed` disclosure above, nothing gets lost or misreported.

Verified on Bedrock (2026-08-26), where channels are dropped: two sessions exchanged messages
and acted on them with zero human input on either side.

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
| `SESSION_BUS_ALERT_COOLDOWN_MS` | How often at most to re-notify while unread messages keep arriving (default 300000 = 5 min) |

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
