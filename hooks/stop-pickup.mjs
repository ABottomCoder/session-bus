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
  watcherStatus, listSessions, channelStatus, wasArmPrompted, markArmPrompted,
} from '../lib/bus.mjs'

const WATCH_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'watch.mjs')

// Arming idle pickup cannot be automated inside the plugin: the wake comes from Claude Code
// re-invoking the model when a task IT launched exits, so the Bash tool has to be the launcher and
// only the model can call it. What the plugin can do is stop making the human responsible for
// noticing. This blocks the end of one turn, once, to get the watcher armed — after which the
// wake -> drain -> re-arm loop sustains itself.
//
// Gated deliberately, because a background process per session is not free:
//   - channels unavailable  : with channels there is nothing to fix
//   - not already armed     : including a watcher armed by an earlier turn
//   - at least one live peer: alone on the bus, nobody can message this session
//   - not already prompted  : the hook cannot arm it, so it cannot clear its own condition
function armPrompt(sid) {
  try {
    if (wasArmPrompted(sid)) return null
    if (watcherStatus(sid).armed) return null
    const chan = channelStatus({ pid: identity().pid })
    if (chan.active) return null
    const peers = listSessions().filter((s) => s.sid !== sid)
    if (!peers.length) return null
    if (!markArmPrompted(sid)) return null
    const names = peers.map((p) => p.label).join(', ')
    return [
      `session-bus: ${peers.length} other session(s) are on the bus (${names}), and this session`,
      'cannot pick up their messages while idle — channels are unavailable here',
      `(${chan.reason}).`,
      '',
      'Arm idle pickup NOW by calling the Bash tool with run_in_background set to true:',
      '',
      `  node ${WATCH_SCRIPT} --sid ${sid} --timeout-s 1800 --settle-ms 8000`,
      '',
      'It runs outside your turn, so it does not block the human talking to you. When it exits the',
      'harness re-invokes you: call session_inbox repeatedly until empty, act, tell the human what',
      'arrived, then re-arm with the same command. A non-zero exit means you are no longer',
      'listening — say so and re-arm.',
      '',
      'This prompt is shown once per session. If idle pickup is genuinely not wanted here, say so to',
      'the human and carry on.',
    ].join('\n')
  } catch { return null }
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
    // Nothing to deliver, but this may be the one chance to get idle pickup armed.
    const prompt = armPrompt(sid)
    if (!prompt) bail()
    const note = 'session-bus: arm idle pickup so peer messages reach this session while idle'
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: prompt,
      hookSpecificOutput: {
        hookEventName: 'Stop',
        block: true,
        reason: note,
        systemMessage: note,
        additionalContext: prompt,
      },
    }))
    process.exit(0)
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

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: body,
    hookSpecificOutput: {
      hookEventName: 'Stop',
      block: true,
      reason: summary,
      systemMessage: summary,
      additionalContext: body,
    },
  }))
  process.exit(0)
} catch {
  bail()
}
