#!/usr/bin/env node
// Stop hook: deliver peer messages at the end of a turn, without the input box.
//
// FAIL-OPEN BY CONTRACT. This runs inside real working sessions, so any error must exit 0
// silently rather than risk wedging one.
//
// Prefers the session id from the hook's own stdin payload, falling back to env/process
// resolution, so it keys the same inbox the MCP server does.
import { identity, unread, markSeen, formatMessages, deliveryBatch } from '../lib/bus.mjs'

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
  if (!all.length) bail()

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
