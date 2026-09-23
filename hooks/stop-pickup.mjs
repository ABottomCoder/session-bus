#!/usr/bin/env node
// Stop hook: deliver peer messages at the end of a turn, without the input box.
//
// FAIL-OPEN BY CONTRACT. This runs inside real working sessions, so any error must exit 0
// silently rather than risk wedging one.
//
// Prefers the session id from the hook's own stdin payload, falling back to env/process
// resolution, so it keys the same inbox the MCP server does.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  identity, unread, markSeen, formatMessages, deliveryBatch,
  watcherStatus, listSessions, channelStatus, armPromptDue, markArmPrompted, clearArmPrompt,
} from '../lib/bus.mjs'

const WATCH_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'watch.mjs')

// Arming idle pickup cannot be automated inside the plugin: the wake comes from Claude Code
// re-invoking the model when a task IT launched exits, so the Bash tool has to be the launcher and
// only the model can call it. What the plugin can do is stop making the human responsible for
// noticing. This blocks the end of a turn to get the watcher armed, after which the
// wake -> drain -> re-arm loop sustains itself.
//
// It is a WATCHDOG, not a one-shot: that loop breaks routinely (interrupt, unre-armed deadline, a
// model deciding it is finished), and a one-shot prompt left the session deaf for good every time
// it did. So the prompt returns whenever the session is unarmed, on a widening backoff that resets
// as soon as it is armed again.
//
// Gated deliberately, because a background process per session is not free:
//   - opt-out not set       : SESSION_BUS_NO_ARM_PROMPT=1 silences this entirely
//   - not currently armed   : including a watcher armed by an earlier turn
//   - backoff elapsed       : the hook cannot arm it, so it cannot clear its own condition
//   - channels unavailable  : with channels there is nothing to fix
//   - at least one live peer: alone on the bus, nobody can message this session
//
// Checks are ordered cheapest-first: watcherStatus is one readdir and armPromptDue one readJson,
// while channelStatus shells out to `ps` and listSessions costs ~210ms (osascript title refresh).
//
// Being armed is also the signal to RESET the backoff, so the next deaf episode is prompted at
// once rather than inheriting the previous episode's wait. This is why the hook is a watchdog now
// and not a one-shot: see the ARM_BACKOFF_MS comment in lib/bus.mjs for the measurement that
// forced the change.
function armPrompt(sid) {
  try {
    if (process.env.SESSION_BUS_NO_ARM_PROMPT === '1') return null
    if (watcherStatus(sid).armed) { clearArmPrompt(sid); return null }
    if (!armPromptDue(sid)) return null
    const chan = channelStatus({ pid: identity().pid })
    if (chan.active) return null
    const peers = listSessions().filter((s) => s.sid !== sid)
    if (!peers.length) return null
    if (!markArmPrompted(sid)) return null
    const names = peers.map((p) => p.label).join(', ')
    return [
      `session-bus: this session is NOT listening for peer mail while idle, and ${peers.length} other`,
      `session(s) can message it (${names}). Channels are unavailable here (${chan.reason}).`,
      '',
      'Arm idle pickup by calling the Bash tool with run_in_background set to true:',
      '',
      `  node ${WATCH_SCRIPT} --sid ${sid} --timeout-s 1800 --settle-ms 8000`,
      '',
      'It runs outside your turn, so it does not block the human talking to you. When it exits, the',
      'harness re-invokes you: call session_inbox until empty, act, tell the human what arrived,',
      'then RE-ARM with the same command. Any non-zero exit means you went deaf — re-arm and say so.',
      '',
      'You will be reminded again while this session stays unarmed, at a widening interval. To stop',
      'the reminders, either arm it or tell the human idle pickup is not wanted here.',
    ].join('\n')
  } catch { return null }
}

// One emit path for both jobs, so the payload can never be attached twice by accident.
//
// `body` goes in the top-level `reason` ONLY. It must NOT also be sent as
// hookSpecificOutput.additionalContext: measured 2026-08-27, an interactive session renders a
// blocking Stop hook's `reason` twice already (once as "Stop hook feedback", once as "Stop hook
// blocking error from command"), and additionalContext added a THIRD identical copy of the whole
// payload. For a full 48k delivery batch that tripled the context cost of one delivery. A
// `claude -p --output-format stream-json` probe confirmed `reason` alone reaches the model (1 copy,
// as a user-role "Stop hook feedback" message) while additionalContext and
// hookSpecificOutput.reason contributed nothing at all. The two remaining copies in interactive
// mode are the harness's own dual rendering of `reason` and are not controllable from here.
//
// `summary` is the short UI line. Keep it short: it is not a place to restate the body.
const emit = (body, summary) => {
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: body,
    hookSpecificOutput: {
      hookEventName: 'Stop',
      block: true,
      systemMessage: summary,
    },
  }))
  process.exit(0)
}

const bail = () => process.exit(0)
const watchdog = setTimeout(bail, 5000)
watchdog.unref?.()

let stdin = ''
try {
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) stdin += chunk
} catch {}

try {
  let sid = null
  try { sid = JSON.parse(stdin || '{}').session_id || null } catch {}
  if (!sid) sid = identity().sid

  const all = unread(sid)
  if (!all.length) {
    // Nothing to deliver. Mail always outranks the prompt, so this is where the watchdog checks
    // whether the session can still hear a peer at all — and resets the backoff when it can.
    const prompt = armPrompt(sid)
    if (!prompt) bail()
    emit(prompt, 'session-bus: arm idle pickup so peer messages reach this session while idle')
  }

  // Batched: a flooded inbox must not be injected into the session's context in one go.
  // Undelivered messages stay unread; the next Stop (or an inbox call) takes the next batch.
  const { batch, more } = deliveryBatch(all)

  // Advance the cursor BEFORE blocking, or the same messages re-inject on every Stop
  // and the session never comes to rest. Only the delivered batch is marked.
  markSeen(sid, batch.map((m) => m.id))

  const body = formatMessages(batch, { more })
  const senders = [...new Set(batch.map((m) => m.fromLabel || m.from))].join(', ')
  const summary = `session-bus: ${batch.length} new message(s) from ${senders}${more ? ` (+${more} queued)` : ''}`

  emit(body, summary)
} catch {
  bail()
}
