#!/usr/bin/env node
// Drives real server instances over real JSON-RPC stdio and a real unix socket.
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { appendFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { sweep, knownSessionIds, unread, cleanLabel, register, listSessions } from '../lib/bus.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, '..', 'mcp', 'server.mjs')
const HOOK = join(HERE, '..', 'hooks', 'stop-pickup.mjs')
const ROOT = join(homedir(), '.claude', 'session-bus')

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`) }
}

class Peer {
  constructor({ sid, label, pid, env = {} }) {
    this.sid = sid; this.label = label
    this.proc = spawn('node', [SERVER], {
      env: {
        ...process.env,
        SESSION_BUS_SID: sid, SESSION_BUS_LABEL: label, SESSION_BUS_PID: String(pid),
        SESSION_BUS_BELL: '0',
        // Default the channel off so the fallback path is what most checks exercise.
        SESSION_BUS_NO_CHANNEL: '1',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.buf = ''; this.pending = new Map(); this.id = 0; this.stderr = ''
    this.notifications = []
    this.proc.stderr.on('data', (d) => { this.stderr += d })
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (c) => {
      this.buf += c
      let nl
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl).trim(); this.buf = this.buf.slice(nl + 1)
        if (!line) continue
        const m = JSON.parse(line)
        if (m.method) { this.notifications.push(m); continue }
        const r = this.pending.get(m.id)
        if (r) { this.pending.delete(m.id); r(m) }
      }
    })
  }
  rpc(method, params) {
    const id = ++this.id
    return new Promise((res) => { this.pending.set(id, res); this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  }
  async call(name, args = {}) {
    const r = await this.rpc('tools/call', { name, arguments: args })
    return r.result?.content?.[0]?.text ?? JSON.stringify(r)
  }
  kill() { this.proc.kill() }
}

const RUN = Date.now().toString(36)
const SID = { a: `sid-alpha-${RUN}`, b: `sid-beta-${RUN}`, c: `sid-gamma-${RUN}` }
const holders = [spawn('sleep', ['180']), spawn('sleep', ['180']), spawn('sleep', ['180'])]
const A = new Peer({ sid: SID.a, label: 'alpha', pid: holders[0].pid })
const B = new Peer({ sid: SID.b, label: 'beta', pid: holders[1].pid })
// Same label as B on purpose: routing must not depend on the label.
const C = new Peer({ sid: SID.c, label: 'beta', pid: holders[2].pid })

for (const p of [A, B, C]) await p.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: {} } })
await new Promise((r) => setTimeout(r, 500))

console.log('\n[0] terminal-title cleaning')
// Terminals append a foreground-process hint. Strip short space-free trailing groups only;
// a parenthesised phrase with spaces is part of the name the user chose.
for (const [inp, want] of [
  ['\u2733 message_test (ps)', 'message_test'],
  ['\u25d0 session_message_tools (python3.13)', 'session_message_tools'],
  ['\u2733 PR 70\u548cPR 12\u5ba1\u67e5 (python3.13)', 'PR 70\u548cPR 12\u5ba1\u67e5'],
  ['review (node) (zsh)', 'review'],
  ['deploy (PR 70 review)', 'deploy PR 70 review'],
  ['build (verylongprocessname)', 'build verylongprocessname'],
  ['(ps)', null],
]) {
  const got = cleanLabel(inp)
  check(`label ${JSON.stringify(inp)} -> ${JSON.stringify(got)}`, got === want, `want ${JSON.stringify(want)}`)
}

console.log('\n[1] identity is the session id, not the label')
const listA = await A.call('sessions_list')
check('own session id is reported', new RegExp(SID.a.slice(0,12)).test(listA), listA)
check('both same-labelled peers are visible', (listA.match(/beta/g) || []).length >= 2, listA)

console.log('\n[2] duplicate labels are refused, not misrouted')
const amb = await A.call('session_send', { to: 'beta', body: 'should not be delivered' })
check('ambiguous label refuses to send', /matches more than one/.test(amb), amb)
check('refusal offers the session ids', new RegExp(`${SID.b.slice(0,12)}|${SID.c.slice(0,12)}`).test(amb), amb)
check('empty inbox for B after refusal', /Inbox empty/.test(await B.call('session_inbox')))
check('empty inbox for C after refusal', /Inbox empty/.test(await C.call('session_inbox')))

console.log('\n[3] addressing by session id works despite the collision')
const bySid = await A.call('session_send', { to: SID.c, body: 'routed by id' })
check('send by session id succeeds', /Delivered to/.test(bySid), bySid)
check('server accepted the live signal', /accepted the delivery signal/.test(bySid), bySid)
check('it reached C, not B', /routed by id/.test(await C.call('session_inbox')))
check('B got nothing', /Inbox empty/.test(await B.call('session_inbox')))

console.log('\n[4] socket wake is event-driven (no 500ms poll floor)')
const t0 = Date.now()
const waiting = B.call('session_wait', { timeout_s: 20 })
await new Promise((r) => setTimeout(r, 800))
const tSend = Date.now()
await A.call('session_send', { to: SID.b, body: 'event driven payload' })
const got = await waiting
const lag = Date.now() - tSend
check('wait returned the message', /event driven payload/.test(got), got)
check(`wake lag ${lag}ms is event-speed (<250ms)`, lag < 250, `lag=${lag}ms, total=${Date.now() - t0}ms`)

console.log('\n[5] timeout is a clean result')
const tt = Date.now()
const to = await B.call('session_wait', { timeout_s: 1 })
check('timeout message', /No message arrived within 1s/.test(to), to)
check(`timeout respected (${Date.now() - tt}ms)`, Date.now() - tt < 4000)

console.log('\n[6] messages never expire; age is disclosed')
mkdirSync(join(ROOT, 'msgs'), { recursive: true })
const old = {
  id: `old-${RUN}`, ts: new Date(Date.now() - 72 * 3600 * 1000).toISOString(),
  from: SID.a, fromLabel: 'alpha', to: SID.b, kind: 'msg',
  body: 'THREE DAYS OLD but still deliverable',
}
appendFileSync(join(ROOT, 'msgs', `${encodeURIComponent(SID.b)}.jsonl`), JSON.stringify(old) + '\n')
const withOld = await B.call('session_inbox')
check('a 3-day-old unread message IS delivered', /THREE DAYS OLD but still deliverable/.test(withOld), withOld)
check('its age is disclosed to the model', /3d old .* while this session was closed/.test(withOld), withOld)

console.log('\n[7] sweep deletes inboxes only for sessions that no longer exist')
const knownIds = [...knownSessionIds()]
check('transcript scan finds real session ids', knownIds.length > 0, `found ${knownIds.length}`)
const dormantSid = knownIds[0]                    // has a transcript => session still exists
const orphanSid = `sid-orphan-${RUN}`             // no transcript, not running => deleted
const inboxOf = (sid) => join(ROOT, 'msgs', `${encodeURIComponent(sid)}.jsonl`)
writeFileSync(inboxOf(dormantSid), JSON.stringify({ id: 'd1', ts: new Date().toISOString(), from: SID.a, to: dormantSid, kind: 'msg', body: 'for a closed but existing session' }) + '\n')
writeFileSync(inboxOf(orphanSid), JSON.stringify({ id: 'o1', ts: new Date().toISOString(), from: SID.a, to: orphanSid, kind: 'msg', body: 'for a deleted session' }) + '\n')
const swept = sweep()
check('orphaned inbox is deleted', !existsSync(inboxOf(orphanSid)), swept.join(','))
check('dormant session keeps its inbox', existsSync(inboxOf(dormantSid)))
try { unlinkSync(inboxOf(dormantSid)) } catch {}

console.log('\n[8] channel is preferred when available, and verified afterwards')
// The channel capability must always be declared, so an opted-in session can register us.
const initCaps = (await A.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} }))
  .result?.capabilities
check('server always declares the claude/channel capability',
  !!initCaps?.experimental?.['claude/channel'], JSON.stringify(initCaps))

// Channel OFF (this machine / no --channels): nothing is pushed, the human path is used.
const noChanSid = `sid-nochan-${RUN}`
const holderN = spawn('sleep', ['120'])
const N = new Peer({ sid: noChanSid, label: 'nochan', pid: holderN.pid })
await N.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
await new Promise((r) => setTimeout(r, 300))
await A.call('session_send', { to: noChanSid, body: 'no channel here' })
await new Promise((r) => setTimeout(r, 600))
check('no channel push when channels are unavailable',
  !N.notifications.some((n) => n.method === 'notifications/claude/channel'),
  JSON.stringify(N.notifications))
check('sessions_list explains why idle delivery falls back',
  /notify-the-human when idle/.test(await N.call('sessions_list')))
check('message is still queued for the fallback paths', unread(noChanSid).length === 1)

// Channel ON: the message is pushed straight in, and NOT pre-marked as read (a push is
// unacknowledged, so marking it read before the model acks would silently lose it).
const chanSid = `sid-chan-${RUN}`
const holderC = spawn('sleep', ['120'])
const C2 = new Peer({
  sid: chanSid, label: 'withchan', pid: holderC.pid,
  env: { SESSION_BUS_NO_CHANNEL: '', SESSION_BUS_FORCE_CHANNEL: '1', SESSION_BUS_CHANNEL_VERIFY_MS: '1200' },
})
await C2.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
await new Promise((r) => setTimeout(r, 300))
await A.call('session_send', { to: chanSid, body: 'PUSHED VIA CHANNEL' })
await new Promise((r) => setTimeout(r, 700))
const pushes = C2.notifications.filter((n) => n.method === 'notifications/claude/channel')
check('a channel notification is emitted', pushes.length === 1, JSON.stringify(C2.notifications).slice(0, 300))
check('the push carries the message body', /PUSHED VIA CHANNEL/.test(pushes[0]?.params?.content || ''), JSON.stringify(pushes[0]?.params).slice(0, 300))
check('the push tells the model to acknowledge', /session_inbox/.test(pushes[0]?.params?.content || ''))
check('the push is not pre-marked read (an unacked push must not lose the message)',
  unread(chanSid).length === 1)
check('sessions_list reports channel mode', /channel push/.test(await C2.call('sessions_list')))

// Acknowledging drains it, which is what suppresses the human fallback.
check('acknowledging via session_inbox drains it', /PUSHED VIA CHANNEL/.test(await C2.call('session_inbox')))
check('drained after ack', unread(chanSid).length === 0)
N.kill(); C2.kill(); holderN.kill(); holderC.kill()

console.log('\n[9] Stop hook keys off the session id from its stdin payload')
await A.call('session_send', { to: SID.b, body: 'hook payload via sid' })
const hookOut = execFileSync('node', [HOOK], {
  encoding: 'utf8',
  input: JSON.stringify({ session_id: SID.b, hook_event_name: 'Stop' }),
  env: { ...process.env, SESSION_BUS_SID: 'wrong-sid-should-be-ignored' },
})
let hook = null
try { hook = JSON.parse(hookOut) } catch {}
check('hook emits valid JSON', !!hook, hookOut.slice(0, 200))
check('hook used the stdin session_id, not the env', /hook payload via sid/.test(JSON.stringify(hook)), hookOut.slice(0, 300))
check('hook blocks the stop', hook?.decision === 'block' && hook?.hookSpecificOutput?.block === true)
const hookOut2 = execFileSync('node', [HOOK], {
  encoding: 'utf8', input: JSON.stringify({ session_id: SID.b }),
})
check('hook silent when drained (no block loop)', hookOut2.trim() === '', JSON.stringify(hookOut2))

console.log('\n[10] unreachable target degrades honestly')
// A registered session whose process is alive but which has no listening socket.
const ghostSid = `sid-ghost-${RUN}`
mkdirSync(join(ROOT, 'sessions'), { recursive: true })
writeFileSync(join(ROOT, 'sessions', `${encodeURIComponent(ghostSid)}.json`), JSON.stringify({
  sid: ghostSid, label: 'ghost', pid: process.pid, tty: null, cwd: '/tmp',
  started: new Date().toISOString(),
}, null, 2))
const ghost = await A.call('session_send', { to: ghostSid, body: 'into the void' })
check('reports that no live signal was sent', /could not reach/.test(ghost), ghost)
check('still stores the message', /Delivered to/.test(ghost), ghost)

console.log('\n[11] dead sessions are pruned')
holders[2].kill()
await new Promise((r) => setTimeout(r, 400))
const afterDeath = await A.call('sessions_list')
check('dead peer pruned', !new RegExp(SID.c.slice(0,12)).test(afterDeath), afterDeath)

console.log('\n[12] labels refresh from live terminal titles at read time')
// A /rename changes the terminal title but nothing ever rewrites the registered file, so
// listSessions must prefer the live title over the stored snapshot — except for pinned
// entries (explicit SESSION_BUS_LABEL). Titles are injected here; no terminal needed.
const renamedSid = `sid-renamed-${RUN}`, pinnedSid = `sid-pinned-${RUN}`
register({ sid: renamedSid, label: 'stale name', pid: holders[0].pid, tty: '/dev/ttysFAKE1', cwd: '/tmp', pinned: false })
register({ sid: pinnedSid, label: 'chosen name', pid: holders[0].pid, tty: '/dev/ttysFAKE2', cwd: '/tmp', pinned: true })
const fresh = new Map([
  ['/dev/ttysFAKE1', '✳ renamed by user (node)'],
  ['/dev/ttysFAKE2', '✳ some other title (node)'],
])
const refreshed = listSessions({ freshTitles: fresh })
const r1 = refreshed.find((s) => s.sid === renamedSid)
const r2 = refreshed.find((s) => s.sid === pinnedSid)
check('live title overrides the stale registered label', r1?.label === 'renamed by user', JSON.stringify(r1))
check('pinned label survives a title refresh', r2?.label === 'chosen name', JSON.stringify(r2))
const noTitle = listSessions({ freshTitles: new Map() }).find((s) => s.sid === renamedSid)
check('stored label is the fallback when no live title', noTitle?.label === 'stale name', JSON.stringify(noTitle))

for (const p of [A, B, C]) p.kill()
for (const h of holders) h.kill()

// Clean up this run's fixtures so repeated runs do not accumulate files for the whole TTL.
await new Promise((r) => setTimeout(r, 200))
let leftover = 0
for (const sid of [SID.a, SID.b, SID.c, ghostSid, `sid-nochan-${RUN}`, `sid-chan-${RUN}`, `sid-renamed-${RUN}`, `sid-pinned-${RUN}`]) {
  for (const [dir, ext] of [['msgs', '.jsonl'], ['cursors', '.json'], ['sock', '.sock'], ['sessions', '.json']]) {
    const f = join(ROOT, dir, `${encodeURIComponent(sid)}${ext}`)
    try { if (existsSync(f)) { unlinkSync(f); leftover++ } } catch {}
  }
}
check(`cleaned up ${leftover} fixture file(s)`, true)
if (A.stderr.trim()) console.log('\nA stderr:', A.stderr.slice(0, 300))
console.log(`\n==== ${pass} passed, ${fail} failed ====`)
process.exit(fail ? 1 : 0)
