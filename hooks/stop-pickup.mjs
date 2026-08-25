#!/usr/bin/env node
// Stop hook: deliver peer messages at the end of a turn, without the input box.
//
// FAIL-OPEN BY CONTRACT. This runs inside real working sessions, so any error must exit 0
// silently rather than risk wedging one.
//
// Prefers the session id from the hook's own stdin payload, falling back to env/process
// resolution, so it keys the same inbox the MCP server does.
import { identity, unread, markSeen, formatMessages } from '../lib/bus.mjs'

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

  const msgs = unread(sid)
  if (!msgs.length) bail()

  // Advance the cursor BEFORE blocking, or the same messages re-inject on every Stop
  // and the session never comes to rest.
  markSeen(sid, msgs.map((m) => m.id))

  const body = formatMessages(msgs)
  const senders = [...new Set(msgs.map((m) => m.fromLabel || m.from))].join(', ')
  const summary = `session-bus: ${msgs.length} new message(s) from ${senders}`

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
