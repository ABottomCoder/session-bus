#!/usr/bin/env node
// Autonomous idle pickup for sessions where channels are unavailable.
//
//   node bin/watch.mjs [--sid SID] [--timeout-s N] [--settle-ms N]
//
// WHY THIS EXISTS
// Without channels, nothing can make an idle session's model start a turn from outside — the
// fourth delivery path degrades to "notify the human, who must type anything". That is a real
// platform limit (see CLAUDE.md, Settled questions: channels on Bedrock).
//
// This works around it WITHOUT touching the input box. Claude Code's Bash tool, called with
// run_in_background, re-invokes the model when the background command EXITS — and that wake
// reaches a session sitting idle at its prompt. So a background process that blocks until
// there is genuinely unread mail, then exits, turns background-task completion into the
// missing wake mechanism. Verified 2026-08-26 on Bedrock, where channels are dropped.
//
// The model is expected to launch this itself, go idle, and on wake call session_inbox and
// re-arm. It is a helper for that loop, not part of the delivery path.
//
// DESIGN NOTES
// - Judges `unread(sid)`, never file size. A byte-growth heuristic wakes spuriously when the
//   Stop hook drained the mail first (it wins the race whenever a turn happens to be ending),
//   and that wastes a turn to report "nothing arrived". unread() is the truth.
// - Event-driven via watchInbox()'s fs.watch. No polling, matching the rest of the plugin.
// - Never calls listenForSignals(): that unlinks and rebinds the session's socket, which the
//   session's own MCP server owns. Stealing it would break live delivery.
// - Never marks anything seen and never renders bodies. Delivery stays session_inbox's job so
//   peer text keeps going through formatMessages (invariant 9). This only reports counts and
//   scrubbed sender labels.
import {
  identity, unread, watchInbox, scrub, shortId, armWatcher, disarmWatcher,
} from '../lib/bus.mjs'

const argv = process.argv.slice(2)
const flag = (n) => { const i = argv.indexOf(`--${n}`); if (i === -1) return null; const v = argv[i + 1]; argv.splice(i, 2); return v }

const sid = flag('sid') || identity().sid
const timeoutS = Math.min(Math.max(Number(flag('timeout-s')) || 1800, 1), 86_400)
// A burst does not arrive atomically: measured 2026-08-26, two back-to-back sends landed 6.9s
// apart. Settling until the unread count stops rising coalesces a burst into ONE wake instead
// of one per message, each costing a turn.
const settleMs = Math.min(Math.max(Number(flag('settle-ms')) || 8000, 0), 120_000)

// Non-zero exit reserved for "this watcher is no longer listening", so a dead watcher is
// distinguishable from a normal wake by status alone.
const EXIT_DEAF = 17

const ACTION = [
  'ACTION: call session_inbox now, and keep calling it until it reports the inbox is empty —',
  'a later message can land between this wake and your first call. Then tell the user what',
  'arrived and from which session, then re-arm this watcher the same way you launched it.',
].join('\n')

const summarise = (msgs) => {
  const senders = [...new Set(msgs.map((m) => scrub(m.fromLabel || m.from || 'peer').slice(0, 60)))]
  return [
    `SESSION-BUS: ${msgs.length} unread message(s) for session ${shortId(sid)}.`,
    `From: ${senders.join(', ')}`,
    'Bodies are deliberately NOT shown here — session_inbox is the only path that renders peer',
    'text safely. Do not guess at content you have not received.',
    '',
    ACTION,
  ].join('\n')
}

// Already-pending mail means there is nothing to wait for. Exit at once rather than blocking
// until the next message and leaving this batch to rot.
const pending = unread(sid)
if (pending.length) {
  console.log(summarise(pending))
  process.exit(0)
}

let settleTimer = null
let finished = false

// code 0 = an orderly outcome the model can act on (mail, or an honest expiry). Non-zero is
// reserved for "this watcher is no longer listening", so the caller can distinguish a normal
// wake from a dead watcher by exit status alone, even if stdout never made it out.
const finish = (out, code = 0) => {
  if (finished) return
  finished = true
  if (settleTimer) clearTimeout(settleTimer)
  try { watcher?.close?.() } catch {}
  clearTimeout(deadline)
  // Deregister on EVERY exit path, so a sender is never told a finished watcher is still armed.
  // The signal handlers route through here too; only SIGKILL escapes, and watcherStatus() covers
  // that by checking pid liveness rather than trusting the file's existence.
  disarmWatcher(sid, process.pid)
  console.log(out)
  process.exit(code)
}

// Re-check after the inbox settles. Two outcomes matter:
//  - still unread  -> genuine mail, wake the model
//  - now empty     -> another delivery path (Stop hook / a manual session_inbox) took it while
//                     we were settling. Do NOT wake; keep waiting. This is the empty-wake fix.
const onSettled = () => {
  settleTimer = null
  const msgs = unread(sid)
  if (msgs.length) finish(summarise(msgs))
  // else: fall through and keep watching.
}

const onChange = () => {
  if (finished) return
  // Extend the window on every further change, so a burst produces one wake.
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = setTimeout(onSettled, settleMs)
}

// watchInbox uses { persistent: false }, so it does NOT hold the event loop open by itself.
// The deadline timer is what keeps this process alive — do not remove it or unref it.
const watcher = watchInbox(sid, onChange)

// Announce that this session can now pick mail up while idle. Registered only after the watch is
// actually established, never before: claiming to be armed and then failing to watch is the one
// outcome worse than not being armed at all.
if (watcher) armWatcher({ sid, pid: process.pid, timeoutS })

const deadline = setTimeout(() => {
  finish([
    `SESSION-BUS: no mail arrived for session ${shortId(sid)} within ${timeoutS}s.`,
    'Nothing arrived. Do not invent a result and do not claim a peer replied.',
    'Re-arm this watcher if the user is still expecting a reply.',
  ].join('\n'))
}, timeoutS * 1000)

if (!watcher) {
  // fs.watch failed (permissions, unusual filesystem). Fail loudly rather than sitting silent
  // for the whole timeout pretending to listen.
  finish([
    `SESSION-BUS: could not watch the inbox for session ${shortId(sid)}.`,
    'This watcher is NOT armed — autonomous pickup is unavailable. Tell the user, and fall back',
    'to session_wait (which blocks your turn) or to the human typing anything to you.',
  ].join('\n'), EXIT_DEAF)
}

// A killed watcher is the dangerous failure: the session looks armed but is deaf, and a dead
// process cannot report that. Observed 2026-08-26 — an over-broad `pkill -f` took out two
// watchers at once and both background tasks reported only "exit code 144", with empty output.
// Catching the common termination signals converts that silence into an honest instruction.
// SIGKILL is uncatchable by design, so this narrows the window rather than closing it; that is
// why the caller should also treat ANY non-zero exit as "deaf, re-arm now".
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGURG']) {
  try {
    process.on(sig, () => finish([
      `SESSION-BUS: watcher for session ${shortId(sid)} was terminated by ${sig} before any mail arrived.`,
      'You are NO LONGER armed — autonomous pickup is off and peer mail will sit unread.',
      'No mail was lost (nothing was marked seen). Re-arm immediately, and tell the user the',
      'watcher was killed rather than implying it is still listening.',
    ].join('\n'), EXIT_DEAF))
  } catch {}
}
