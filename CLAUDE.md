# session-bus

> Read this before touching the code. It records **what was already tried and ruled out with
> evidence**, so you don't spend hours re-discovering dead ends. If you disagree with a
> decision here, check the "Settled questions" table first — most of them were settled by
> running something, not by reasoning.

## What this is

A Claude Code plugin that lets multiple **local** Claude Code sessions send each other
messages. The user says "send the conclusion to the review session" and it arrives in that
session — **never through its input box**, so it can't be confused with something the human
typed.

One sentence of architecture: *each session's MCP server owns an inbox keyed by that session's
id and listens on a unix socket; a sender appends to the inbox and pokes the socket; the
receiver surfaces it as a tool result, as a channel push, or as end-of-turn hook context,
whichever fits its current state.*

## Quick Start

```bash
node test/smoke.mjs                    # 48 checks, needs nothing installed. Run this first.
claude plugin validate .               # manifest check

# Iterating on the code: load this directory directly, no install, no cache.
claude --plugin-dir "$PWD"

# Installing for real:
claude plugin marketplace add .
claude plugin install session-bus@session-bus --scope user

# After editing code, `plugin update` is NOT enough (it is version-gated — see Gotchas):
claude plugin uninstall session-bus && claude plugin install session-bus@session-bus --scope user
```

Turning it off: `claude plugin disable session-bus` (reversible with `enable`), or
`claude plugin uninstall session-bus` + `claude plugin marketplace remove session-bus`, plus
`rm -rf ~/.claude/session-bus` to drop runtime data. Either way, **already-running sessions keep
working until they restart** — their MCP server process and Stop hook were attached at launch.

No build step. No `npm install`. **Zero dependencies is a deliberate constraint** — it is why
a colleague can install this with two commands. Do not add a dependency without a very good
reason.

## Architecture

```
bin/bus.mjs             CLI: list / send / inbox / whoami / sweep
                        Lets a shell, or a session without the MCP server, act as a sender.
mcp/server.mjs          MCP server, one instance per session. Hand-rolled JSON-RPC over
                        stdio (no SDK — that is what keeps dependencies at zero).
                        Exposes 4 tools; listens on the session's unix socket.
hooks/stop-pickup.mjs   Stop hook. Delivers pending messages at the end of a turn.
hooks/hooks.json        Declares the Stop hook to Claude Code.
lib/bus.mjs             Everything shared: identity, inbox, signalling, sweep, rendering.
.mcp.json               Declares the MCP server (uses ${CLAUDE_PLUGIN_ROOT}).
.claude-plugin/         plugin.json (the plugin) + marketplace.json (so it is installable).
.gitignore              nothing is generated; this only guards against accidents.
test/smoke.mjs          48 checks against real server processes, real JSON-RPC, real sockets.
```

### Runtime state (per machine, never in the repo)

```
~/.claude/session-bus/
  sessions/<sid>.json     one file per live session — NOT one shared registry (see Invariants)
  msgs/<sid>.jsonl        the inbox, append-only, one JSON object per line
  cursors/<sid>.json      { seen: [messageId, ...] } — how far this session has read
  sock/<sid>.sock         the delivery signal socket, owned by that session's server
```

### The four delivery paths

Delivery depends on what the receiver is doing and whether channels work there. This is the
core of the design.

| Receiver state | Mechanism | Latency | Human action |
|---|---|---|---|
| Blocked in `session_wait` | socket event resolves the pending tool call | ~25ms measured | none |
| Mid-turn (working) | `Stop` hook injects via `additionalContext` | end of that turn | none |
| Idle **and channels available** | `notifications/claude/channel` pushes it straight in | immediate | none |
| Idle, no channels | macOS notification + terminal bell | — | must say *anything* |

The last row is a platform limit, not laziness: **without channels, nothing can make an idle
session's model start a turn from outside.** But the human doesn't need to know any command —
once they type anything at all, the Stop hook delivers at the end of that turn.

### The channel path, and why it needs verifying

Channels are the *preferred* idle-delivery mechanism when available. The problem is that a
channel push is **fire-and-forget**: Claude Code never acknowledges
`notifications/claude/channel`, and silently drops it when the session wasn't started with
`--channels` or when policy blocks it. So the server cannot learn from the push whether it
landed. Two mechanisms compensate:

1. **Decide up front** (`channelStatus()` in `lib/bus.mjs`) by reading the launching `claude`
   process's own command line via `ps -o args=`, plus an early-out on Bedrock. If channels
   clearly aren't available we go straight to notifying the human, so that case keeps its
   current zero-delay behaviour instead of waiting on a timeout.
2. **Verify afterwards.** A push instructs the model to call `session_inbox` to acknowledge.
   After `SESSION_BUS_CHANNEL_VERIFY_MS` (default 25s) the server re-checks: if those message
   ids are *still unread*, the push evidently didn't land and the human is notified after all.

`sessions_list` reports which mode the session is in and why, so a surprising outcome is
diagnosable rather than mysterious.

**Status: VERIFIED on a channel-capable machine (macOS, claude.ai auth, 2026-08-25).**
Receiver launched with `claude --dangerously-load-development-channels
plugin:session-bus@session-bus`; `sessions_list` reported `channel push`. A CLI send to the
idle receiver woke it with nothing typed into it: it reported the message and called
`session_inbox` on its own, and the read cursor on disk confirmed the message id as seen.
(The original implementation machine was Bedrock, where channels are unavailable — see
Settled questions.)

## Settled questions — do NOT re-litigate without new evidence

| Idea | Verdict | How it was established |
|---|---|---|
| Use **channels** (`notifications/claude/channel`) as the *only* transport | **No** — it is a transport, not a message system. It provides no addressing, no durable inbox, no read cursors, no peer identity. It also needs a per-session `--channels` launch flag (and `--resume` does not restore flags), is in research preview, and custom channels are off the Anthropic allowlist. Now used as an *opportunistic* idle-delivery path with fallback | reasoned from the docs plus the flag behaviour we verified |
| Channels **on Bedrock** | **Unavailable.** Events silently dropped, no error even with `--debug`, reproduced twice | Built a channel server, ran `claude -p --dangerously-load-development-channels`; server logged 4 successful pushes, model saw none |
| Use **MCP sampling** so the server starts a model turn | **Not supported.** Client capabilities are `{roots, elicitation}` only | Logged the real `initialize` params Claude Code sends |
| Use **MCP elicitation** to push | Accepted, but **useless for delivery** — it asks the human and returns data to the server; it injects no context and starts no turn | Sent an unsolicited `elicitation/create`; client replied `{"action":"cancel"}` in 7ms under `-p` |
| Type into the terminal (`tmux send-keys`, iTerm `write text`) | **Rejected by the user by design** — indistinguishable from their own input. The one comparable OSS tool (`DhanushSantosh/AgentComms`) does exactly this | product decision |
| Poll on a timer / cron | Works, but burns a full turn per tick even when the inbox is empty | `CronCreate` docs: jobs fire while the REPL is idle |
| A single shared `registry.json` | **Race.** Sessions starting simultaneously clobber each other's entries | Caught by the test suite: 3 servers started together, one entry vanished |
| A 24h message TTL | Removed. Session ids are unique so a new session can never inherit an old inbox; the key solves it, an expiry is not needed | user decision after the keying change |

## Invariants — breaking these causes real bugs

1. **The routing key is the session id, never the label.** `CLAUDE_CODE_SESSION_ID` is present
   in every MCP server's environment. Terminal titles are cosmetic, they change as Claude
   renames tabs, and they collide. On a label collision the send is **refused** and the model
   is told to ask the human — never guess.
2. **Only ever write your own session's state file.** This is why `sessions/` is one file per
   session. Never reintroduce a shared file that requires read-modify-write.
3. **The Stop hook must fail open.** It runs inside real working sessions. Every error path
   exits 0 silently, and there is a 5s watchdog. A crash here would wedge someone's work.
4. **The Stop hook must advance the read cursor BEFORE it blocks.** Otherwise the same message
   re-injects on every subsequent Stop and the session never comes to rest. There is a test
   for exactly this ("hook silent when drained").
5. **A wake is a hint, not a guarantee.** `fs.watch` can fire for a write that predates the
   current wait. `session_wait` must re-check and keep waiting on a spurious wake rather than
   returning empty. There is a test for this too.
6. **Peer messages are data, not instructions.** Delivered text explicitly says it came from
   another session and that destructive or outward-facing actions still need human
   confirmation. Without this, session A could tell session B to `git push --force`.
7. **`sweep()` must no-op if the transcript scan returns nothing.** A moved or renamed
   `~/.claude/projects/` would otherwise delete every inbox on the machine.
8. **Never mark a message read just because it was pushed over a channel.** The push is
   unacknowledged; pre-marking would silently destroy the message on any machine where the
   channel is registered but the event doesn't land. The read cursor advances only when the
   model actually calls `session_inbox` (or another delivery path drains it). There is a test
   for this: "the push is not pre-marked read".
9. **Declaring the `claude/channel` capability must stay unconditional.** It is what lets an
   opted-in session register us, and it is harmless where channels don't work — the server
   still serves tools normally (verified on Bedrock).

## Inbox lifetime

- Messages **never expire**. An unread message waits indefinitely.
- `claude --resume` **keeps the same session id**, so unread messages survive a restart.
  Verified: a forced id reported identically before and after a resume.
  `--resume --fork-session` mints a new id, so it starts with an empty inbox.
- Delivered messages **disclose their age** (`(3d old — sent while this session was closed)`)
  so a stale message doesn't read as current.
- An inbox is deleted only when its session is genuinely gone: process not running **and** no
  transcript at `~/.claude/projects/*/<sid>.jsonl`. A closed-but-existing session keeps its
  inbox. `sweep()` runs on every server start.

## Gotchas

- **Installing makes a CACHED COPY, and `plugin update` is VERSION-GATED.** The plugin installs
  to `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, *not* a link to this repo.
  `claude plugin update` compares version strings — if you edited code without bumping
  `plugin.json`, it reports "already at the latest version" and **silently leaves stale code
  installed**. This bit us for real: `lib/bus.mjs` in the cache was one revision behind while
  `update` claimed it was current. During development, refresh with:

  ```bash
  claude plugin uninstall session-bus && claude plugin install session-bus@session-bus --scope user
  ```

  Then always confirm, rather than trusting the command:

  ```bash
  diff -r . ~/.claude/plugins/cache/session-bus/session-bus/<version>
  ```

  Better still, use `claude --plugin-dir "$PWD"` while iterating — it reads this directory
  directly and skips the cache entirely.
- **MCP servers only attach at session start.** A running session cannot pick up a newly
  installed plugin. It must be restarted. `claude --resume` keeps its id and inbox.
- **`--resume` does not restore launch flags.** A session resumed with plain `claude --resume`
  loses any `--mcp-config` / `--plugin-dir` it originally had. This wasted a debugging cycle.
- **Test isolation:** cursors persist on disk, so a test using fixed session ids will pass once
  and then fail on re-run because the fixture message is already marked read. `test/smoke.mjs`
  derives per-run ids and cleans up after itself. Keep it that way.
- **`--allowedTools ""` is the strongest proof for hook delivery.** A receiver with no tool
  access that still reports the message body cannot have fetched it — the hook is the only
  possible source. Use this pattern when verifying delivery.
- **`claude --plugin-dir <path>`** loads this plugin for one session only. Use it to test
  hooks without a global install polluting the user's real sessions.
- **Don't ask a model to count to 200 as words** in a test prompt: it trips
  `API Error: Output blocked by content filtering policy`. Use substantive prose to burn time.

## Label cleaning

**Labels are refreshed from the live terminal titles at read time, not only at registration.**
The registered label is a snapshot from server start; `/rename` changes the terminal title but
nothing ever rewrites the file, so resolving by the new name used to fail (found 2026-08-25:
a renamed session was unreachable by its new name). `listSessions()` now overlays labels from
`liveTitlesByTty()` — one batch osascript for all iTerm panes plus one `tmux list-panes -a` —
and writes nothing back, so the "only write your own state file" invariant holds. An explicit
`SESSION_BUS_LABEL` sets `pinned: true` at registration and is never overridden. AppleScript
gotcha pinned in a comment: inside a `tell application "iTerm2"` block, `tab` resolves to
iTerm's tab *class*, not the character constant — bind the separator outside the block.

Labels come from the terminal title, which arrives decorated: a status glyph, the name, and a
trailing foreground-process hint. `cleanLabel()` strips trailing parenthesised groups that are
**short (≤12 chars) and space-free** — `(ps)`, `(zsh)`, `(python3.13)` — and repeats, since a
title can carry several. A parenthesised phrase containing spaces is treated as part of the
name the user chose and kept (`deploy (PR 70 review)`). If nothing survives, identity falls
back to `basename(cwd)`. Cases are pinned in test section [0]; add to them rather than
loosening the regex.

## Environment variables

| Var | Effect |
|---|---|
| `SESSION_BUS_LABEL` | Override the human-facing label |
| `SESSION_BUS_BELL=0` | Suppress the terminal bell |
| `SESSION_BUS_ELICIT=1` | Also raise an elicitation dialog when idle (experimental) |
| `SESSION_BUS_FORCE_CHANNEL=1` | Treat channels as available regardless of detection |
| `SESSION_BUS_NO_CHANNEL=1` | Never use the channel path |
| `SESSION_BUS_CHANNEL_VERIFY_MS` | Push verification window, default 25000 |
| `SESSION_BUS_SID` / `SESSION_BUS_PID` | Test-only identity overrides |

## Platform notes

| Feature | Requirement |
|---|---|
| Core bus (inbox, sockets, hook, tools) | Node 18+, POSIX. Platform-neutral. |
| Label from terminal title | iTerm2 (AppleScript) or tmux (`display-message`). Otherwise falls back to `basename(cwd)`. |
| Notifications | macOS `osascript`. Silently skipped elsewhere. |
| `ps`-based identity | POSIX `ps`. Walks up from the server's pid to find the `claude` process and its tty. |

Every external command call is wrapped in try/catch and degrades to a fallback. Adding Windows
support means replacing the `ps` walk and the notifier; the rest is portable.

## Publishing checklist

The repo is self-contained — copying this directory to another machine is sufficient. There is
no build output, no `node_modules`, and no absolute paths (verified by grep; the only
machine-specific strings are the author emails in `.claude-plugin/*.json`).

1. Update the author fields in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.
2. `node test/smoke.mjs` — expect 48/48 on the new machine.
3. `claude plugin validate .` — expect "Validation passed".
4. **Verify the channel path** (see below) — ✅ done 2026-08-25, passed on first real run.
5. `git init && git add -A && git commit` then push.
6. Verify a real consumer install from the pushed URL:
   `claude plugin marketplace add <url> && claude plugin install session-bus@session-bus`,
   restart a session, and confirm `sessions_list` reports it.
   ✅ Verified 2026-08-25 against https://github.com/ABottomCoder/session-bus (github.com).
   **Still unverified:** whether `marketplace add` can authenticate against a GitHub
   Enterprise host. Test this before telling colleagues it works.

### Verifying the channel path on a channel-capable machine

Requires non-Bedrock auth (claude.ai or a Console API key) and Node 18+. Two terminals.

```bash
# Terminal A — the receiver, opted into channels.
claude --dangerously-load-development-channels plugin:session-bus@session-bus
```

Accept the full-screen development-channel warning. Then in that session:

> run sessions_list

Expected: `Idle-delivery mode for this session: channel push (reaches this session even when
idle)`. If it instead says `notify-the-human when idle (...)`, the reason is printed — fix that
before going further.

```bash
# Terminal B — send while A sits idle at its prompt. Do NOT type in A.
node bin/bus.mjs list                       # note A's sid
node bin/bus.mjs send <A-sid> "channel path verification"
```

**Pass condition:** session A reacts on its own, with nothing typed into it — it should report
the message and call `session_inbox`. That is the behaviour no other path can produce.

Failure modes and what they mean:
- A does nothing, then ~25s later a macOS notification appears → the push was dropped and the
  verification fallback correctly caught it. Check `--channels` naming and org policy.
- A reacts but never calls `session_inbox` → delivery worked, the acknowledgement instruction
  did not. The fallback will fire a redundant notification; tighten the `instructions` string.

Record the outcome in this file either way, and update the "Status" note under
[The channel path](#the-channel-path-and-why-it-needs-verifying).

Colleague-facing instructions live in `README.md`.
