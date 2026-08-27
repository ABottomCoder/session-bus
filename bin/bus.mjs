#!/usr/bin/env node
// CLI for session-bus — testing, shell senders, and sessions without the MCP server loaded.
//
//   bus list
//   bus send <to> <body...>   [--from-label NAME] [--kind msg]
//   bus inbox [--sid SID] [--peek]
//   bus whoami
//   bus sweep
import {
  identity, register, listSessions, resolveTarget, send, unread, markSeen,
  formatMessages, signal, sweep, watcherStatus,
} from '../lib/bus.mjs'

const argv = process.argv.slice(2)
const cmd = argv.shift()
const flag = (n) => { const i = argv.indexOf(`--${n}`); if (i === -1) return null; const v = argv[i + 1]; argv.splice(i, 2); return v }
const bool = (n) => { const i = argv.indexOf(`--${n}`); if (i === -1) return false; argv.splice(i, 1); return true }

const fromLabel = flag('from-label')
const sidOverride = flag('sid')
const peek = bool('peek')
const kind = flag('kind') || 'msg'

const base = identity()
const me = {
  ...base,
  sid: sidOverride || base.sid,
  label: fromLabel || base.label,
}

if (cmd === 'whoami') {
  console.log(JSON.stringify(me, null, 2))
} else if (cmd === 'list') {
  const list = listSessions()
  if (!list.length) console.log('(no live sessions registered)')
  for (const s of list) {
    // idle-pickup is shown because otherwise a human has no way to tell whether a session will act
    // on mail while idle, short of asking that session — which is exactly the burden the watcher
    // exists to remove. One command, from any terminal, answers it.
    const w = watcherStatus(s.sid)
    const idle = w.armed
      ? `armed${w.count > 1 ? `x${w.count}` : ''}`
      : 'NOT-armed'
    console.log(`${s.sid === me.sid ? '*' : ' '} ${s.label}\tsid=${s.sid.slice(0, 12)}\tunread=${s.unread}\tpid=${s.pid}\tidle-pickup=${idle}`)
  }
  const unarmed = list.filter((s) => !watcherStatus(s.sid).armed)
  if (list.length > 1 && unarmed.length) {
    console.log(`\n${unarmed.length} session(s) will NOT act on peer mail while idle. In such a session, say:`)
    console.log('  arm the session-bus watcher')
  }
} else if (cmd === 'send') {
  const to = argv.shift()
  const body = argv.join(' ')
  if (!to || !body) { console.error('usage: bus send <to> <body...>'); process.exit(2) }
  try { register(me, { ifAbsent: true }) } catch {}
  const { match, peers, ambiguous } = resolveTarget(to, me.sid)
  if (!match) {
    console.error(ambiguous ? `ambiguous target "${to}"` : `no live session matches "${to}"`)
    for (const p of peers) console.error(`  ${p.label}  sid=${p.sid.slice(0, 12)}`)
    process.exit(1)
  }
  const msg = send({
    toSid: match.sid, toLabel: match.label, from: me.sid, fromLabel: me.label, body, kind,
  })
  const signalled = await signal(match.sid, {
    type: 'deliver', id: msg.id, from: me.sid, fromLabel: me.label, preview: body.slice(0, 140),
  })
  console.log(`delivered to "${match.label}" sid=${match.sid.slice(0, 12)} id=${msg.id} signalled=${signalled}`)
} else if (cmd === 'inbox') {
  const msgs = unread(me.sid)
  if (!msgs.length) { console.log('(inbox empty)'); process.exit(0) }
  if (!peek) markSeen(me.sid, msgs.map((m) => m.id))
  console.log(formatMessages(msgs))
} else if (cmd === 'sweep') {
  const removed = sweep()
  console.log(removed.length ? `removed ${removed.length} orphaned file(s):\n${removed.join('\n')}` : 'nothing to sweep')
} else {
  console.error('usage: bus [list|send|inbox|whoami|sweep]')
  process.exit(2)
}
