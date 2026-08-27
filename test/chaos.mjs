#!/usr/bin/env node
// L3 fault & chaos tests (production-playbook 第三层): corrupted state on disk, dead/stale
// sockets, oversized and garbage input, process kills, malformed JSON-RPC. Oracle for every
// case: degrade cleanly — no crash, no hang, no data loss, and the failure is DISCLOSED.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync, appendFileSync, unlinkSync, existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import {
  send, readInbox, unread, markSeen, signal, sockPath, formatMessages, watcherStatus, sweep,
} from '../lib/bus.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, '..', 'mcp', 'server.mjs')
const HOOK = join(HERE, '..', 'hooks', 'stop-pickup.mjs')
const ROOT = join(homedir(), '.claude', 'session-bus')
const RUN = Date.now().toString(36)
let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`) }
}
const cleanup = []
const sidOf = (name) => { const s = `sid-${name}-${RUN}`; cleanup.push(s); return s }

// Minimal JSON-RPC peer (same shape as smoke.mjs, trimmed).
class Peer {
  constructor(sid, pid) {
    this.proc = spawn('node', [SERVER], {
      env: { ...process.env, SESSION_BUS_SID: sid, SESSION_BUS_LABEL: 'chaos', SESSION_BUS_PID: String(pid), SESSION_BUS_BELL: '0', SESSION_BUS_NO_CHANNEL: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.buf = ''; this.pending = new Map(); this.id = 0
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (c) => {
      this.buf += c
      let nl
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl).trim(); this.buf = this.buf.slice(nl + 1)
        if (!line) continue
        let m; try { m = JSON.parse(line) } catch { continue }
        const r = this.pending.get(m.id)
        if (r) { this.pending.delete(m.id); r(m) }
      }
    })
  }
  raw(s) { this.proc.stdin.write(s) }
  rpc(method, params, timeoutMs = 5000) {
    const id = ++this.id
    return new Promise((res) => {
      const t = setTimeout(() => res({ timeout: true }), timeoutMs)
      this.pending.set(id, (m) => { clearTimeout(t); res(m) })
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  async call(name, args = {}) {
    const r = await this.rpc('tools/call', { name, arguments: args })
    return r.timeout ? '(rpc timeout)' : r.result?.content?.[0]?.text ?? JSON.stringify(r)
  }
  alive() { try { process.kill(this.proc.pid, 0); return true } catch { return false } }
  kill(sig) { this.proc.kill(sig) }
}

console.log('\n[C1] corrupted inbox lines: good messages survive, bad ones are skipped')
{
  const sid = sidOf('corrupt')
  send({ toSid: sid, from: 'x', body: 'good-1' })
  const p = join(ROOT, 'msgs', `${encodeURIComponent(sid)}.jsonl`)
  appendFileSync(p, 'THIS IS NOT JSON\n{"half": \n\x00\x01garbage\n')
  send({ toSid: sid, from: 'x', body: 'good-2' })
  const msgs = readInbox(sid)
  check('both good messages readable through the garbage', msgs.filter((m) => /^good-/.test(m.body)).length === 2, JSON.stringify(msgs))
  check('no crash rendering an inbox that held garbage', typeof formatMessages(unread(sid)) === 'string')
}

console.log('\n[C2] corrupted cursor: falls back to "nothing seen", never crashes or loses mail')
{
  const sid = sidOf('badcursor')
  send({ toSid: sid, from: 'x', body: 'survivor' })
  markSeen(sid, ['some-other-id'])
  writeFileSync(join(ROOT, 'cursors', `${encodeURIComponent(sid)}.json`), '\x00\xff NOT JSON AT ALL')
  check('unread() still returns the message', unread(sid).length === 1)
  markSeen(sid, unread(sid).map((m) => m.id))
  check('marking seen still works after corruption', unread(sid).length === 0)
}

console.log('\n[C3] stale socket (server died): send is stored, failure is disclosed')
{
  const sid = sidOf('stale')
  writeFileSync(sockPath(sid), '')  // a plain file where a socket should be
  const t0 = Date.now()
  const ok = await signal(sid, { type: 'deliver' })
  check('signal() fails fast on a dead socket', ok === false && Date.now() - t0 < 2000, `ok=${ok} in ${Date.now() - t0}ms`)
  send({ toSid: sid, from: 'x', body: 'stored despite dead socket' })
  check('message is durably stored anyway', unread(sid).length === 1)
}

console.log('\n[C4] MCP server survives garbage stdin, oversized socket floods, and answers after')
{
  const sid = sidOf('server')
  const holder = spawn('sleep', ['60'])
  const peer = new Peer(sid, holder.pid)
  await peer.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
  peer.raw('NOT JSON\n{"jsonrpc":"2.0","truncated\n\n')
  const pong = await peer.rpc('ping', {})
  check('server answers ping after garbage stdin', !pong.timeout && !pong.error, JSON.stringify(pong))

  // Flood the signal socket: 50 connections of garbage, one oversized (64k > 16k cap).
  await new Promise((r) => setTimeout(r, 300))
  const floods = Array.from({ length: 50 }, (_, i) => new Promise((res) => {
    const s = connect(sockPath(sid))
    s.on('connect', () => { s.end(i === 0 ? 'x'.repeat(64 * 1024) : 'garbage not json') })
    s.on('error', () => res()); s.on('close', () => res())
    setTimeout(res, 2000)
  }))
  await Promise.all(floods)
  check('server alive after 50-connection garbage/oversize flood', peer.alive())
  const list = await peer.call('sessions_list')
  check('tools still respond after the flood', /You are/.test(list), list.slice(0, 80))

  // SIGTERM: graceful unregister — session file and socket removed.
  peer.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 500))
  const sessFile = join(ROOT, 'sessions', `${encodeURIComponent(sid)}.json`)
  check('SIGTERM unregisters: session file gone', !existsSync(sessFile))
  check('SIGTERM unregisters: socket gone', !existsSync(sockPath(sid)))
  holder.kill()
}

console.log('\n[C5] SIGKILL (no cleanup chance): next server start recovers the identity')
{
  const sid = sidOf('kill9')
  const holder = spawn('sleep', ['60'])
  const p1 = new Peer(sid, holder.pid)
  await p1.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
  await new Promise((r) => setTimeout(r, 200))
  p1.kill('SIGKILL')
  await new Promise((r) => setTimeout(r, 300))
  // Stale socket + stale session file are left behind. A restarted server must reclaim both.
  const p2 = new Peer(sid, holder.pid)
  await p2.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
  await new Promise((r) => setTimeout(r, 300))
  send({ toSid: sid, from: 'x', body: 'after-kill9' })
  const ok = await signal(sid, { type: 'deliver', preview: 'after-kill9' })
  check('restarted server reclaims the socket (signal accepted)', ok === true)
  const got = await p2.call('session_inbox')
  check('message delivered after SIGKILL recovery', /after-kill9/.test(got), got.slice(0, 120))
  p2.kill(); holder.kill()
}

console.log('\n[C6] Stop hook: garbage stdin, missing state, watchdog — always exits 0')
{
  const run = (stdin) => new Promise((res) => {
    const h = spawn('node', [HOOK], { env: { ...process.env, SESSION_BUS_SID: sidOf('hooknone') }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    h.stdout.on('data', (d) => { out += d })
    const t = setTimeout(() => { h.kill('SIGKILL'); res({ code: 'HUNG', out }) }, 7000)
    h.on('exit', (code) => { clearTimeout(t); res({ code, out }) })
    h.stdin.write(stdin); h.stdin.end()
  })
  const garbage = await run('TOTALLY NOT JSON \x00\xff')
  check('hook exits 0 on garbage stdin', garbage.code === 0, `code=${garbage.code}`)
  check('hook silent when inbox empty', garbage.out.trim() === '', garbage.out.slice(0, 80))
  const huge = await run('{"session_id": "' + 'x'.repeat(100000) + '"}')
  check('hook exits 0 on absurd session id', huge.code === 0, `code=${huge.code}`)
}

console.log('\n[C7] hostile message fields: bad ts, missing fields, null body — render never crashes')
{
  const weird = [
    { id: 'w1', ts: 'NOT A DATE', from: 'x', body: 'bad ts' },
    { id: 'w2', ts: new Date().toISOString(), from: null, fromLabel: null, body: null },
    { id: 'w3', ts: new Date(Date.now() + 86400000).toISOString(), from: 'x', body: 'from the future' },
  ]
  let out = null
  try { out = formatMessages(weird) } catch (e) { out = null }
  check('formatMessages survives hostile field values', typeof out === 'string' && out.includes('bad ts'), String(out).slice(0, 100))
}

console.log('\n[C8] inbox flood: delivery is batched, overflow stays unread and is disclosed')
{
  const { deliveryBatch } = await import('../lib/bus.mjs')
  const sid = sidOf('flood')
  for (let i = 0; i < 120; i++) send({ toSid: sid, from: 'flooder', body: `flood-${i}` })
  const out = await new Promise((res) => {
    const h = spawn('node', [HOOK], { stdio: ['pipe', 'pipe', 'pipe'] })
    let o = ''
    h.stdout.on('data', (d) => { o += d })
    h.on('exit', () => res(o))
    h.stdin.write(JSON.stringify({ session_id: sid })); h.stdin.end()
  })
  const remaining = unread(sid).length
  check('hook delivers a bounded batch (50), not the whole flood', remaining === 70, `remaining=${remaining}`)
  check('overflow is disclosed in the delivery', /70 more unread/.test(out), out.slice(-200))
  check('hook summary flags the queue', /\+70 queued/.test(out), out.slice(0, 200))
  // A giant-body flood must be bounded by chars, not just count.
  const big = Array.from({ length: 20 }, (_, i) => ({ id: `b${i}`, body: 'x'.repeat(10_000) }))
  const { batch, more } = deliveryBatch(big)
  check('char cap kicks in before count cap on huge bodies', batch.length < 20 && more > 0 && batch.length >= 1,
    `batch=${batch.length} more=${more}`)
}

console.log('\n[C9] notification gate: empty→non-empty alerts, floods stay quiet, cooldown re-alerts')
{
  const { makeAlertGate } = await import('../lib/bus.mjs')
  const gate = makeAlertGate({ cooldownMs: 10_000 })
  const t = 1_000_000
  check('first message into empty inbox alerts', gate(1, t) === true)
  check('pile-up within cooldown stays silent', gate(2, t + 1000) === false && gate(50, t + 2000) === false)
  check('cooldown elapsed with mail still arriving re-alerts once', gate(51, t + 12_000) === true && gate(52, t + 13_000) === false)
  check('drained-then-new-message alerts immediately', gate(1, t + 14_000) === true)
}

console.log('\n[C10] corrupt or hostile watcher registrations degrade to "not armed", never throw')
// watcherStatus() is called on the send path, so a bad file here must not take a send down with
// it — and it must never claim armed on evidence it cannot trust. "Not armed" is the safe answer:
// it makes a sender warn the human, whereas a false "armed" would make it report a message as
// actionable when nothing is listening.
{
  const sid = sidOf('watchcorrupt')
  const wdir = join(ROOT, 'watchers')
  mkdirSync(wdir, { recursive: true })
  const wpath = (pid) => join(wdir, `${encodeURIComponent(sid)}__${pid}.json`)
  const cases = [
    ['truncated JSON', '{"sid":"x","pid":'],
    ['not JSON at all', 'this is not json'],
    ['empty file', ''],
    ['valid JSON, no pid', JSON.stringify({ sid, timeoutS: 60 })],
    ['pid is a string', JSON.stringify({ sid, pid: 'not-a-number', timeoutS: 60 })],
    ['pid is negative', JSON.stringify({ sid, pid: -5, timeoutS: 60 })],
    ['pid 0', JSON.stringify({ sid, pid: 0, timeoutS: 60 })],
    ['pid that cannot exist', JSON.stringify({ sid, pid: 4294967295, timeoutS: 60 })],
    ['a JSON array', JSON.stringify([1, 2, 3])],
    ['NUL and control bytes', '{"pid": [2J}'],
  ]
  let threw = null, claimedArmed = []
  for (const [name, body] of cases) {
    try { writeFileSync(wpath(name.replace(/\W/g, '')), body) } catch {}
    try {
      const st = watcherStatus(sid)
      if (st.armed) claimedArmed.push(name)
    } catch (e) { threw = `${name}: ${e.message}` }
  }
  check('no corrupt registration made watcherStatus throw', threw === null, String(threw))
  check('no corrupt registration was reported as armed', claimedArmed.length === 0,
    claimedArmed.join('; '))

  // A registration whose pid is alive but which is otherwise minimal must still read as armed —
  // the guard must not be so strict that it ignores real watchers.
  writeFileSync(wpath(process.pid), JSON.stringify({ sid, pid: process.pid }))
  const good = watcherStatus(sid)
  check('a minimal but LIVE registration still reads as armed', good.armed === true, JSON.stringify(good))
  check('missing timeoutS degrades to null rather than breaking', good.timeoutS === null, JSON.stringify(good))

  // sweep() must reclaim every unusable file rather than leaving litter that is re-parsed forever.
  sweep()
  let leftover = 0
  try {
    for (const f of readdirSync(wdir)) {
      if (f.startsWith(`${encodeURIComponent(sid)}__`) && !f.endsWith(`__${process.pid}.json`)) leftover++
    }
  } catch {}
  check('sweep reclaimed all the unusable registrations', leftover === 0, `leftover=${leftover}`)
  try { unlinkSync(wpath(process.pid)) } catch {}
}

// ---- cleanup
for (const sid of cleanup) {
  for (const [dir, ext] of [['msgs', '.jsonl'], ['cursors', '.json'], ['sock', '.sock'], ['sessions', '.json']]) {
    const f = join(ROOT, dir, `${encodeURIComponent(sid)}${ext}`)
    try { if (existsSync(f)) unlinkSync(f) } catch {}
  }
  try {
    for (const f of readdirSync(join(ROOT, 'watchers'))) {
      if (f.startsWith(`${encodeURIComponent(sid)}__`)) {
        try { unlinkSync(join(ROOT, 'watchers', f)) } catch {}
      }
    }
  } catch {}
}
console.log(`\n==== ${pass} passed, ${fail} failed ====`)
process.exit(fail ? 1 : 0)
