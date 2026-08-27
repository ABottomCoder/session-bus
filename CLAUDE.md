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
node test/smoke.mjs                    # L1: 78 functional checks. Run this first.
node test/watch.mjs                    # L1: 69 checks for bin/watch.mjs (autonomous idle pickup)
node test/stress.mjs                   # L2: 20 concurrency/race checks (multi-process)
node test/chaos.mjs                    # L3: 30 fault-injection checks
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
bin/watch.mjs           Autonomous idle pickup where channels are unavailable. A session runs
                        this as a BACKGROUND task; the harness re-invokes the model when a
                        background task exits, which reaches an idle session. Not part of the
                        delivery path — a helper the receiving model arms for itself.
mcp/server.mjs          MCP server, one instance per session. Hand-rolled JSON-RPC over
                        stdio (no SDK — that is what keeps dependencies at zero).
                        Exposes 4 tools; listens on the session's unix socket.
hooks/stop-pickup.mjs   Stop hook. Delivers pending messages at the end of a turn.
hooks/hooks.json        Declares the Stop hook to Claude Code.
lib/bus.mjs             Everything shared: identity, inbox, signalling, sweep, rendering.
.mcp.json               Declares the MCP server (uses ${CLAUDE_PLUGIN_ROOT}).
.claude-plugin/         plugin.json (the plugin) + marketplace.json (so it is installable).
.gitignore              nothing is generated; this only guards against accidents.
test/smoke.mjs          L1: 78 checks against real server processes, real JSON-RPC, real sockets.
test/watch.mjs          L1: 69 checks for bin/watch.mjs — real child processes, real inboxes.
test/stress.mjs         L2: 20 concurrency/race checks — real multi-process interleavings.
test/chaos.mjs          L3: 30 fault-injection checks — corruption, floods, kills, garbage.
```

### Test campaign record (2026-08-25, v0.5.0, production-playbook L1–L5)

| Layer | Evidence | Result |
|---|---|---|
| L1 business | smoke.mjs 78 checks (was 55; +3 empty-inbox reclamation, +6 stale-snapshot sweep race, +2 watcher-file permissions, +11 idle-pickup disclosure, +1 corrected wake-latency measurement) | ✅ 78/78, and **stable**: repeated clean runs at load 4.5 where it previously failed ~50% |
| L1 watcher | watch.mjs 69 checks (2026-08-26, v0.10.0): wake, already-pending early-out, burst coalescing, drain-during-settle must NOT wake, cursor untouched, socket untouched, body non-disclosure, kill reports deafness with non-zero exit, armed-state registration + deregistration on every exit path, SIGKILL reads as not-armed, sweep reclaims stale registrations, fs.watch-failure branch, per-pid registration with no mutual deregistration | ✅ 69/69 |
| L2 concurrency | stress.mjs 20 checks; found+fixed cursor RMW race (96/200 lost), 500-id seen-cap resurrection, and [S7] a live session's socket being swept by another server's stale snapshot | ✅ 20/20 after fix |
| L3 fault/chaos | chaos.mjs 30 checks (+5 for corrupt/hostile watcher registrations); found+fixed newline-fusion append loss; flood batching + alert coalescing added after v0.5 review; SIGKILL recovery, floods, corruption all clean | ✅ 30/30 after fix |
| L4 security | semgrep OSS important-only (p/javascript+nodejs+trailofbits+secrets): 0 findings; gitleaks full history: 0 leaks; zero deps → no CVE surface; hardening suite in smoke [13] | ✅ |
| L5 observability | sessions_list reports true mode+reason (desktop, no channels); dead-socket send discloses WARNING + storage; live E2E: new sender × old cached receiver over channel path, autonomous ack in ~1s | ✅ |

Node floor: everything above ran on Node v18.20.8 — the declared minimum is the tested version.

### RESOLVED: the smoke [3]/[4] flakiness was a real production race (2026-08-26, v0.10.0)

It presented as "`session_wait` doesn't wake" and it was actually **`sweep()` deleting a live
session's delivery socket**. Root cause and fix are in invariant 7b; this records how it was found,
because the first two rounds of diagnosis were wrong and the wrong turns are worth not repeating.

| Step | Result |
|---|---|
| Read the failure text and reason about it | **Wrong conclusion.** "The signal is accepted yet the waiter never wakes" — an artefact of reading [3]'s signal assertion together with [4]'s wake result. They are different sends, and **[4] never asserted on its own signal at all**. |
| Ruled out startup latency | Raising the post-`initialize` sleep 500ms → 2500ms changed nothing over 5 runs. |
| Ruled out `listSessions()` blocking the receiver | Timed at ~210ms (osascript 208ms of it) — real, but far under the 1500ms `signal()` timeout. |
| **Built an instrumented repro** recording `sockBefore` / `signalled` / `unreadAfter` per iteration | 5/20 failed, and **all 5 had no socket at send time**; "signal accepted but wake lost" was 0. The earlier conclusion was simply false. |
| **Probed the socket's lifetime** at 15ms resolution | `gone → EXISTS@330ms → gone@345ms`, 4/12 runs, `neverCreated=0`. So it was **created and then deleted** — which is why more startup sleep could never have helped. |
| Attributed the deletion, twice | Single server: 0/10 deletions. Two servers with `sweep()` removed from a copy: 0/12. With `sweep()` enabled: 4/12. |
| Fixed and re-verified | repro 5/20 → **0/20**; socket probe 4/12 → **0/12**; smoke **10/10 clean at load 4.5**, where it had been failing ~50% of runs. |

The lesson, and it is the same one this file keeps recording: **reasoning from a test's output text
produced a confident wrong answer twice; instrumenting the actual resource found it in one pass.**
When a flake resists explanation, stop theorising and measure the thing that is supposedly missing.

A note on the test that was almost shipped: racing two real servers reproduces this only 17–33% of
the time, and the rate moves with machine load. A 6-pair version **passed against the pre-fix code**,
i.e. it was a test that could not fail. It was replaced with stress [S7], which removes the timing
dependence by injecting the stale snapshot against a real bound socket — verified to fail pre-fix
(3 checks red, including end-to-end reachability) and pass post-fix.

### Historical: what the flakiness looked like before it was understood

`smoke.mjs` sections **[3] addressing by session id** and **[4] socket wake is event-driven** fail
intermittently on a loaded machine — roughly half of runs at load average ~4. Observed failures,
all one cascade from a single root cause:

```
FAIL  server accepted the live signal
FAIL  wait returned the message
FAIL  wake lag 19201ms is event-speed (<250ms)      <- 19.2s ≈ the test's own 20s session_wait timeout
FAIL  timeout message                               <- [5] inherits the undrained message
```

What has been established:

- **Pre-existing, not caused by the sweep change.** Reverted the `sweep()` hunk and re-ran 6×;
  the same [3]/[4] failures appeared at the same rate.
- **Not a startup-timing problem.** Raising the post-`initialize` wait from 500ms to 2500ms did
  not help (5 runs).
- **Not `listSessions()` blocking.** Timed at ~210ms (`liveTitlesByTty()` 208ms of that,
  osascript) — real cost, but nowhere near the 1500ms `signal()` timeout.
- **In the 19.2s runs the signal WAS accepted** and the waiter still did not wake, so it is not
  simply an unreachable socket.
- **The `<250ms` assertion in [4] was measuring the wrong thing — now fixed.** It timed the whole
  `session_send` tool call, which includes the SENDER's own `listSessions()` (~210ms of it the
  osascript title refresh), leaving ~40ms of headroom and failing at 255-264ms on a busy machine.
  The sender's title refresh is not what "event-driven" means. [4] now measures from the moment the
  message becomes available, via `send()` + `signal()` directly, and reports **2-8ms**. The
  end-to-end tool path is still asserted, just without a timing bound.

Root cause **is** now identified — see the table above and invariant 7b. Kept only as a record of
the symptom, so a similar signature is recognised faster next time.

### Runtime state (per machine, never in the repo)

```
~/.claude/session-bus/
  sessions/<sid>.json     one file per live session — NOT one shared registry (see Invariants)
  msgs/<sid>.jsonl        the inbox, append-only, one JSON object per line
  cursors/<sid>.json      APPEND-ONLY lines of {"seen":[ids]} — how far this session has read.
                          Unioned on read; compacted only at that session's own server start.
  sock/<sid>.sock         the delivery signal socket, owned by that session's server
  watchers/<sid>__<pid>.json
                          {sid, pid, timeoutS, started} — one file per ARMED watcher, keyed by sid
                          AND pid. Liveness is by PID, never by the file's existence, so a
                          SIGKILLed watcher reads as not-armed. Per-pid for the same reason
                          sessions/ is per-session (invariant 2): a shared key let one watcher
                          deregister another.
```

### The four delivery paths

Delivery depends on what the receiver is doing and whether channels work there. This is the
core of the design.

| Receiver state | Mechanism | Latency | Human action |
|---|---|---|---|
| Blocked in `session_wait` | socket event resolves the pending tool call | ~25ms measured | none |
| Mid-turn (working) | `Stop` hook injects via `additionalContext` | end of that turn | none |
| Idle **and channels available** | `notifications/claude/channel` pushes it straight in | immediate | none |
| Idle **and a watcher is armed** | `bin/watch.mjs` exits; the harness re-invokes the model | ~11s measured (8s settle + watch latency) | none |
| Idle, nothing armed, no channels | macOS notification + terminal bell | — | must say *anything* |

The last row is a platform limit: **nothing in the delivery path can make an idle session's
model start a turn from outside.** But the human doesn't need to know any command — once they
type anything at all, the Stop hook delivers at the end of that turn.

The watcher row is a **workaround from outside the delivery path**, not a fifth transport. See
[The watcher path](#the-watcher-path-autonomous-pickup-without-channels).

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

### The watcher path: autonomous pickup without channels

`bin/watch.mjs` recovers idle autonomy on machines where channels are dropped. It is **not** a
transport and not part of delivery — it only supplies the missing *wake*.

The mechanism: Claude Code's Bash tool with `run_in_background` **re-invokes the model when the
background command exits**, and that wake reaches a session sitting idle at its prompt. So a
background process that blocks until there is genuinely unread mail, then exits, does what a
channel push would have done. The receiving model arms it for itself, goes idle, and on wake
drains `session_inbox` and re-arms.

**Status: VERIFIED on Bedrock, 2026-08-26** — the machine where channels are dropped. Isolated
the wake mechanism first with a bare `sleep 20` background task (woke an idle session, zero
human input, confirmed by the harness's own "NOT USER INPUT" tagging), then ran a full two-session
loop: peer received a task, ran real commands, replied, and the sender reported it — with no
human input on either side.

**Live branch coverage on Bedrock**, measured across the two-session loop:

| Branch | Live status |
|---|---|
| Already-pending early-out (`unread()` non-empty at arm time) | ✅ exercised |
| Mail wake | ✅ exercised — **~11s end-to-end** (armed 17:15:36, woke 17:19:10 on a 00:18:59Z send), consistent with the 8s settle plus `fs.watch` latency. Printed count and sender label only; the body arrived via `session_inbox`, as intended. |
| Clean deadline expiry | ✅ exercised — a full ~1793s window, exit 0, honest notice, inbox genuinely empty |
| Signal kill | ✅ exercised — the `pkill` incident, before the handlers existed; the handled path is covered by [W10] |
| **`fs.watch` failed (the `!watcher` branch)** | ✅ **now covered** by [W15]. Previously recorded as un-injectable; it is injectable after all — a session id long enough to push the inbox path past the filesystem limit makes `watchInbox()` return null. The branch exits immediately, says "NOT armed", offers the fallbacks, exits non-zero, and does not register itself. |
| Two watchers armed for one session | ✅ covered by [W16]. Registration is per-pid, so neither deregisters the other, and the redundancy is reported so `session_send` can warn about duplicate wakes. |
| Channel push **and** a watcher both active | ✅ safe by the same mechanism [W3] pins, and no separate test is needed: whichever path drains the inbox first wins, and the other watcher re-checks `unread()`, finds it empty, and keeps waiting instead of firing. The only cost is a possible redundant wake — no loss, no duplication. Do not arm a watcher on a channel-capable session; there is no reason to. |

Three design calls, each for a reason found by testing:

1. **Judge `unread(sid)`, never inbox file size.** The first version compared bytes and woke
   spuriously: the Stop hook wins the race whenever a turn happens to be ending, so the mail was
   already delivered while the file had still grown. That burned a turn to report "nothing
   arrived". Pinned by test [W3].
2. **Never call `listenForSignals()`.** It unlinks and rebinds the session's socket, which that
   session's own MCP server owns — using it here would break live delivery. Pinned by [W8],
   which greps the source as well as checking that no socket appears.
3. **Never render bodies, never mark seen.** Invariant 9 keeps `formatMessages` as the single
   choke point for untrusted peer text; the watcher reports counts and scrubbed sender labels
   only, and leaves the cursor alone so `session_inbox` still delivers. Pinned by [W7], [W9].

#### Armed state is observable, and why that is the actual fix

**The failure it prevents (real, 2026-08-26):** two sessions were winding down a task. The peer
decided it was finished and stopped re-arming its watcher. The other session then sent a closing
message, read `Delivered ... Its server accepted the delivery signal`, and reported to its human
that *the peer had received it*. It had not. It sat unread with nothing listening.

Nothing was lost — the inbox is durable and the human **was** notified (`makeAlertGate` treats
`unreadCount <= 1` as the empty→non-empty transition, so the 5-minute cooldown does not suppress
it). The defect was **observability**: `session_send` enumerated all four delivery paths, which
reads as reassurance, and the sender had no way to learn which one actually applied.

So `bin/watch.mjs` now registers itself in `watchers/<sid>.json` while armed, and:

- `sessions_list` reports `idle-pickup=armed | NOT armed` per peer, so a sender can check *before*
  sending.
- `session_send` states the outcome instead of listing possibilities. When the target is not
  armed it says so explicitly and adds *"Do NOT report this as received or acted on."*

This mirrors the Kubernetes shutdown ordering: an endpoint is removed from load balancing **before**
the process stops listening, precisely so callers stop assuming availability instead of discovering
it afterwards. Registration happens only *after* `watchInbox()` succeeds — advertising readiness
and then failing to watch is worse than never advertising.

Four properties are load-bearing, each with a test:

1. **Deregistration on every exit path** ([W12]). All exits funnel through `finish()`, including
   the signal handlers. A finished watcher that still advertises itself is the worst state, because
   senders keep believing the peer can act unprompted.
2. **Liveness by pid, not by file** ([W13]). SIGKILL cannot be caught, so the file survives;
   `watcherStatus()` checks the pid and cleans the stale file on read.
3. **`sweep()` reclaims stale registrations independently of transcripts** ([W14]), and *before* the
   `known.size === 0` early return. This is a deliberate reaction to the empty-inbox leak: cleanup
   gated on transcript existence never runs on a machine that keeps transcripts forever. Watcher
   files must not inherit that bug.
4. **One file per watcher, keyed by sid AND pid** ([W16]). A per-sid file looked simpler and was
   wrong for the same reason a shared `registry.json` was (invariant 2): arming twice for one
   session — easy, since the protocol tells a woken model to re-arm — made the second watcher
   overwrite the first's entry, and whichever exited first deregistered BOTH. `watcherStatus` then
   reported not-armed while a live watcher was still listening, so senders were told the peer would
   not act when it would. `watcherStatus` now reports `count`, and `session_send` warns when more
   than one is armed, because that means duplicate wakes for one message.

Operational notes:

- **A burst does not arrive atomically.** Two back-to-back sends landed 6.9s apart (measured
  2026-08-26). Without the settle window the watcher fires on the first and each remaining
  message costs another wake. `--settle-ms` extends while the inbox keeps growing, so a burst
  coalesces into one wake ([W4]).
- **Drain `session_inbox` to empty before re-arming.** The settle window narrows the gap between
  wake and pickup but does not close it; a message can land in between.
- **Winding down: keep a drain window, and never stop silently.** When a collaboration ends, do not
  disarm right after sending "done" — re-arm once with a short window (say `--timeout-s 120`) and
  stop only after it expires with an empty inbox. This is the same grace period Kubernetes and TCP
  `TIME_WAIT` use, and it is a *mitigation, not a guarantee*: per the Two Generals result in Settled
  questions, no protocol closes this gap. What makes it safe rather than merely likely is that the
  inbox is durable and the sender can now **see** that the peer is no longer armed.
- **A killed watcher must not be silent.** A dead process cannot report that the session is now
  deaf. Signal handlers catch SIGTERM/SIGINT/SIGHUP/SIGURG, print an explicit "no longer armed,
  re-arm immediately", and exit **non-zero** so a dead watcher is distinguishable from a normal
  wake by status alone ([W10], [W11]). SIGKILL is uncatchable, which is why the caller should
  treat *any* non-zero exit as "deaf".
- **Stop a watcher with `TaskStop` and its task id, never a broad `pkill -f`.** A `pkill -f`
  matching the script path killed the watchers of *both* sessions on this machine at once
  (2026-08-26), and the resulting empty output plus `exit 144` was initially misdiagnosed as a
  harness lifetime ceiling.

**Background-task lifetime: no ceiling up to ~1800s** (measured 2026-08-26), which covers the
default `--timeout-s 1800` end to end. Four independent observations:

| Observation | Duration | How it was seen |
|---|---|---|
| Probe, 30s ticks | 900s clean, exit 0 | own background task |
| Probe, 30s ticks | 1200s clean, exit 0 | peer session's background task |
| A live watcher process still running | ~1577s | own `pgrep` on the peer's watcher, armed 16:45:43, observed at 17:12 |
| A watcher reaching its full deadline | ~1793s, exit 0, correct expiry text, `session_inbox` empty | peer session's task output |

An earlier report of a "~600s harness ceiling" was wrong: that watcher died at 683s, about 31s
before the over-broad `pkill` that killed it was announced, so no ceiling is needed to explain it.
Nothing to clamp against; the existing clamp of `--timeout-s` at 86400 stands.

Two things the full-window run also confirmed, which the short unit tests can only approximate:
the deadline path **self-reports instead of dying silent** (exit 0 + text, versus the killed case's
non-zero + empty output), and the `unread()`-over-byte-size guard produced **zero spurious wakes
across a whole 1800s window**.

If a ceiling is ever found above this, clamp to it — a watcher that outlives one dies *without
printing its expiry notice*, which is the invisible-deafness failure the signal handlers exist to
prevent.

## Settled questions — do NOT re-litigate without new evidence

| Idea | Verdict | How it was established |
|---|---|---|
| Use **channels** (`notifications/claude/channel`) as the *only* transport | **No** — it is a transport, not a message system. It provides no addressing, no durable inbox, no read cursors, no peer identity. It also needs a per-session `--channels` launch flag (and `--resume` does not restore flags), is in research preview, and custom channels are off the Anthropic allowlist. Now used as an *opportunistic* idle-delivery path with fallback | reasoned from the docs plus the flag behaviour we verified |
| Channels **on Bedrock** | **Unavailable.** Events silently dropped, no error even with `--debug`, reproduced twice | Built a channel server, ran `claude -p --dangerously-load-development-channels`; server logged 4 successful pushes, model saw none |
| Use **MCP sampling** so the server starts a model turn | **Not supported.** Client capabilities are `{roots, elicitation}` only | Logged the real `initialize` params Claude Code sends |
| Use **MCP elicitation** to push | Accepted, but **useless for delivery** — it asks the human and returns data to the server; it injects no context and starts no turn | Sent an unsolicited `elicitation/create`; client replied `{"action":"cancel"}` in 7ms under `-p` |
| Type into the terminal (`tmux send-keys`, iTerm `write text`) | **Rejected by the user by design** — indistinguishable from their own input. The one comparable OSS tool (`DhanushSantosh/AgentComms`) does exactly this | product decision |
| Poll on a timer / cron | Works, but burns a full turn per tick even when the inbox is empty | `CronCreate` docs: jobs fire while the REPL is idle |
| **Background-task exit as the wake for an idle session** | **Adopted** as `bin/watch.mjs`, for machines with no channels. A background task's exit re-invokes the model even while it sits idle, so it supplies the wake channels would have. Costs nothing while waiting and, unlike `session_wait`, does not occupy the turn — the human can still talk to the session | Isolated with a bare `sleep 20` background task on Bedrock (woke an idle session, zero human input), then a full two-session autonomous loop, 2026-08-26 |
| Use `session_wait` for the same job | **Only when the human is deliberately not going to talk to that session.** It blocks the turn, so the human's input queues until mail arrives or the timeout fires — a 600s default meant up to 10 minutes of apparent deafness to the human | Read the handler (`mcp/server.mjs:245`), then reproduced the queuing behaviour interactively |
| Fix the wind-down gap (peer disarms, then mail arrives) with an **acknowledgement handshake** — "done" → "ack" → "ack the ack" | **No. Provably impossible.** This is the Two Generals' Problem: no finite protocol, deterministic or not, gives both parties mutual certainty over a channel where the last message may not be acted on. Consider the final message — if it were dropped the receiver stops, and the sender cannot distinguish that from success. Adding rounds moves the uncertainty, never removes it. The engineering answers are the ones used in practice: make availability **observable** (implemented — `watchers/`, and disclosure in `session_send`/`sessions_list`), keep a **drain window** before going quiet (a documented convention, not code), and rely on the durable inbox so nothing is lost regardless | [Two Generals' Problem](https://en.wikipedia.org/wiki/Two_Generals%27_Problem) for the impossibility result; [Kubernetes Pod termination](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/) for the drain/announce ordering that is actually used |
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
7b. **`sweep()` must re-check liveness against the session's OWN file immediately before deleting
   anything — never from a snapshot.** Building the `live` set via `listSessions()` costs ~210ms
   (osascript title refresh plus a scan of every transcript). A session that registered and bound
   its socket inside that window is missing from the snapshot, and a brand-new session has no
   transcript either, so it is missing from `known` too. Before the fix, another server starting at
   the same moment **deleted a fully alive session's socket** — measured 2026-08-26: bound at
   ~330ms, unlinked at ~345ms, in 4 of 12 simultaneous starts, versus 12 of 12 surviving with
   `sweep()` disabled. The victim stays unreachable for live signals until it restarts, because
   nothing recreates the path: `session_wait` never wakes from a socket again and every send to it
   degrades to "could not reach that session's delivery socket". Use `isLiveSid()`, which reads one
   file and checks one pid, and never reintroduce a decision made from a stale snapshot. Pinned by
   smoke [7] (injected stale snapshot) and stress [S7] (real server, real bound socket, plus an
   end-to-end reachability check).
8. **Never mark a message read just because it was pushed over a channel.** The push is
   unacknowledged; pre-marking would silently destroy the message on any machine where the
   channel is registered but the event doesn't land. The read cursor advances only when the
   model actually calls `session_inbox` (or another delivery path drains it). There is a test
   for this: "the push is not pre-marked read".
9. **Message bodies render quoted, scrubbed, and never at top level.** `formatMessages` is the
   single choke point where untrusted peer text enters a model's context: every body line gets
   a `> ` prefix (a body faking a frame header or NOTE renders as visibly quoted data — no
   closing delimiter exists to escape), and bodies/labels/cwds pass through `scrub()` (strips
   ANSI + control chars) before reaching a terminal, a notification, or model context. Do not
   add a render path that bypasses this, and keep the NOTE (with its "sender is claimed, not
   authenticated" line) after the bodies at top level.
10. **The read cursor is append-only — never reintroduce read-modify-write on it.** The MCP
   server (draining a channel ack), the Stop hook, and the CLI can all mark messages seen
   concurrently; a read-modify-write cursor lost updates and re-delivered those messages
   (measured worst case 96/200, test/stress.mjs [S2]). Each markSeen appends one atomic
   `{"seen":[ids]}` line (with a leading newline so a truncated last line can never swallow
   it — chaos [C2]); reads union all lines; compaction runs only in the session's OWN server
   at start. There is deliberately no cap on the seen set: a 500-id cap resurrected old
   messages once the inbox outgrew it (stress [S3]).
11. **Declaring the `claude/channel` capability must stay unconditional.** It is what lets an
   opted-in session register us, and it is harmless where channels don't work — the server
   still serves tools normally (verified on Bedrock).

## Trust model (hardened 2026-08-25, v0.4.0)

Everything runs as one OS user on one machine. What is and is not defended:

- **NOT defendable here: a malicious process running as the same user.** It can write inboxes
  directly, impersonate any sender, or read anything — that is the OS trust boundary, same as
  for `~/.ssh`. The CLI's `--sid`/`--from-label` overrides make this explicit rather than
  pretending otherwise.
- **Defended: other OS users.** All runtime dirs are 0700 and files/sockets 0600 (`ensureDirs`
  enforces dir modes on every call; `sweep()` repairs pre-hardening file modes once per server
  start).
- **Defended: prompt injection via message content** — the realistic attack: a message body
  faking frame headers, system notices, or "the human approved X", aimed at a receiver running
  in a permissive permission mode. Mitigated by invariant 9 (quoted rendering + scrub) and by
  the NOTE telling the receiver the sender is unauthenticated and confirmation is required for
  destructive actions. Defense in depth, not proof: a sufficiently gullible model is still the
  weak link, which is why the NOTE exists *and* the framing makes fakes visually distinct.
- **Defended: resource abuse.** Send-side body cap (`MAX_BODY` 64k, truncation disclosed),
  render-side cap (16k/message), and a 16k cap on the signal socket buffer — a peer cannot
  blow out a receiver's context or the server's memory, maliciously or by accident.
  Delivery is also **batched** (`deliveryBatch`: ≤50 messages / ≤48k chars per delivery,
  overflow stays unread and is disclosed) so a flooded inbox cannot be injected into the
  receiver's context in one turn, and **notifications are coalesced** (`makeAlertGate`:
  alert on empty→non-empty, then at most once per `SESSION_BUS_ALERT_COOLDOWN_MS`) so a
  looping sender cannot flood the notification center.
- **Sender identity is a claim.** Verifying it same-user is impossible (anything provable is
  forgeable by the same access), so the rendering says so instead of implying authority.

## Inbox lifetime

- Messages **never expire**. An unread message waits indefinitely.
- `claude --resume` **keeps the same session id**, so unread messages survive a restart.
  Verified: a forced id reported identically before and after a resume.
  `--resume --fork-session` mints a new id, so it starts with an empty inbox.
- Delivered messages **disclose their age** (`(3d old — sent while this session was closed)`)
  so a stale message doesn't read as current.
- An inbox **holding messages** is deleted only when its session is genuinely gone: process not
  running **and** no transcript at `~/.claude/projects/*/<sid>.jsonl`. A closed-but-existing
  session keeps its inbox. `sweep()` runs on every server start.
- **An EMPTY inbox is reclaimed as soon as the session is not live**, even if its transcript still
  exists. `watchInbox()` creates the file at every server start, so a session that never receives
  anything still leaves a 0-byte file — and since transcript retention can be effectively
  permanent (`cleanupPeriodDays`), the known-sid guard would protect those files forever, one per
  session that ever ran. Measured on a machine with `cleanupPeriodDays: 3650000`: a disposable
  session left a 0-byte inbox that repeated `sweep()` calls would not remove. Reclaiming it loses
  nothing, because there is no message in it. Only inboxes are treated this way — a cursor or
  socket belonging to a still-existing session is left alone. Pinned by three checks in smoke [7],
  including one asserting that a NON-empty inbox for the same class of session still survives.

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
- **`watchInbox()` uses `{ persistent: false }`, so it does NOT hold the event loop open.** Inside
  `mcp/server.mjs` that is correct — the socket server keeps the process alive. Any *standalone*
  consumer must keep itself alive by other means; `bin/watch.mjs` relies on its deadline timer,
  and removing or `unref`-ing that timer would make the watcher exit instantly and look like an
  immediate false wake.
- **Never stop a background watcher with a broad `pkill -f`.** The pattern matches the script
  path, not the process owner, so `pkill -f watch` reaches watchers belonging to *other* sessions
  on the same machine. This happened for real (2026-08-26): two sessions were disarmed at once,
  and because a killed process cannot print, both showed only `exit 144` with empty output — which
  was then misdiagnosed as a harness lifetime ceiling before the timeline ruled it out. Use
  `TaskStop` with the task id, or at minimum match your own sid.

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
| `SESSION_BUS_ALERT_COOLDOWN_MS` | Notification re-alert cooldown while unread mail keeps arriving, default 300000 |
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
2. `node test/smoke.mjs && node test/stress.mjs && node test/chaos.mjs` — expect 55/55,
   14/14, 25/25 on the new machine (verified 2026-08-25 on macOS / Node 18.20.8).
3. `claude plugin validate .` — expect "Validation passed".
4. **Verify the channel path** (see below) — ✅ done 2026-08-25, passed on first real run.
5. `git init && git add -A && git commit` then push.
6. Verify a real consumer install from the pushed URL:
   `claude plugin marketplace add <url> && claude plugin install session-bus@session-bus`,
   restart a session, and confirm `sessions_list` reports it.
   ✅ Verified 2026-08-25 against https://github.com/ABottomCoder/session-bus (github.com).
   Public github.com distribution is fully verified — this is the path for individual users.
   (Only relevant if a company wants to mirror this internally: whether `marketplace add`
   can authenticate against a GitHub Enterprise host is untested. N/A for public release.)

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
