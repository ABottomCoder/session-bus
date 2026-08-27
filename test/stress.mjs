#!/usr/bin/env node
// L2 concurrency & race tests (production-playbook 第二层).
// Attacks the three theoretical weak points: multi-process append interleaving,
// markSeen read-modify-write races, and the 500-entry seen-cursor cap.
// Self-cleaning; per-run sids like smoke.mjs.
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { unlinkSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  send, readInbox, unread, markSeen, register, listSessions,
  sweep, isLiveSid, knownSessionIds, signal,
} from '../lib/bus.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(homedir(), '.claude', 'session-bus')
const RUN = Date.now().toString(36)
let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`) }
}
const cleanup = []
const sidOf = (name) => { const s = `sid-${name}-${RUN}`; cleanup.push(s); return s }

// Child helper that surfaces failures: a worker that dies (EAGAIN, OOM, syntax) would
// otherwise masquerade as a race/lost-update failure in the parent's assertions.
const runChild = (args) => new Promise((res) => {
  const c = spawn('node', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  c.stderr.on('data', (d) => { err += d })
  c.on('exit', (code) => res({ code, err: err.slice(0, 200) }))
  c.on('error', (e) => res({ code: -1, err: String(e) }))
})
const allZero = (rs) => rs.every((r) => r.code === 0)
const childErrs = (rs) => rs.filter((r) => r.code !== 0).map((r) => `code=${r.code} ${r.err}`).join(' | ')

console.log('\n[S1] concurrent multi-process appends: no lost or corrupted messages')
{
  const sid = sidOf('append')
  const WRITERS = 8, EACH = 50
  const script = `
    import { send } from '${join(HERE, '..', 'lib', 'bus.mjs')}'
    const [sid, w, n] = process.argv.slice(1)
    for (let i = 0; i < Number(n); i++) send({ toSid: sid, from: 'w' + w, body: \`w\${w}-m\${i}\` })
  `
  const rs = await Promise.all(Array.from({ length: WRITERS }, (_, w) =>
    runChild(['--input-type=module', '-e', script, sid, String(w), String(EACH)])))
  check('all writer processes exited 0', allZero(rs), childErrs(rs))
  const msgs = readInbox(sid)
  const bodies = new Set(msgs.map((m) => m.body))
  const ids = new Set(msgs.map((m) => m.id))
  check(`all ${WRITERS * EACH} messages present, none corrupted`, msgs.length === WRITERS * EACH, `got ${msgs.length}`)
  check('no duplicate or garbled bodies', bodies.size === WRITERS * EACH, `unique=${bodies.size}`)
  check('message ids unique across processes', ids.size === msgs.length, `unique=${ids.size}`)
}

console.log('\n[S2] concurrent markSeen from two processes (server + Stop hook can race)')
{
  // Two processes each mark a disjoint half of the same inbox as seen, concurrently.
  // A lost update here means messages get re-delivered (duplicate injection).
  let worstLost = 0
  for (let round = 0; round < 5; round++) {
    const sid = sidOf(`seenrace${round}`)
    for (let i = 0; i < 200; i++) send({ toSid: sid, from: 'x', body: `m${i}` })
    const all = readInbox(sid).map((m) => m.id)
    const half = (k) => JSON.stringify(all.filter((_, i) => i % 2 === k))
    const script = `
      import { markSeen } from '${join(HERE, '..', 'lib', 'bus.mjs')}'
      const [sid, idsJson] = process.argv.slice(1)
      for (const id of JSON.parse(idsJson)) markSeen(sid, [id])
    `
    const rs = await Promise.all([0, 1].map((k) =>
      runChild(['--input-type=module', '-e', script, sid, half(k)])))
    if (!allZero(rs)) { check(`round ${round}: marker child failed (NOT a race)`, false, childErrs(rs)); continue }
    const lost = unread(sid).length
    worstLost = Math.max(worstLost, lost)
  }
  check('no seen-updates lost across concurrent markers (0 re-deliverable)', worstLost === 0,
    `worst round re-delivers ${worstLost}/200 — read-modify-write race on cursor file`)
}

console.log('\n[S3] seen-cursor cap: reading >500 messages must not resurrect old ones')
{
  const sid = sidOf('cap')
  const N = 600
  for (let i = 0; i < N; i++) send({ toSid: sid, from: 'x', body: `m${i}` })
  const ids = readInbox(sid).map((m) => m.id)
  markSeen(sid, ids) // cursor stores at most the last 500 seen ids
  const back = unread(sid)
  check(`after reading all ${N}, unread stays 0`, back.length === 0,
    `${back.length} old read messages resurfaced as unread (seen cap 500 < inbox size)`)
}

console.log('\n[S4] 10 simultaneous registrations: per-file registry loses nobody')
{
  const holders = Array.from({ length: 10 }, () => spawn('sleep', ['30']))
  const sids = holders.map((h, i) => { const s = sidOf(`reg${i}`); return { sid: s, pid: h.pid } })
  const rs = await Promise.all(sids.map((m) =>
    runChild(['--input-type=module', '-e',
      `import { register } from '${join(HERE, '..', 'lib', 'bus.mjs')}'
       register({ sid: process.argv[1], label: 'r', pid: Number(process.argv[2]), tty: null, cwd: '/tmp' })`,
      m.sid, String(m.pid)])))
  check('all register processes exited 0', allZero(rs), childErrs(rs))
  const live = new Set(listSessions().map((s) => s.sid))
  const missing = sids.filter((m) => !live.has(m.sid))
  check('all 10 concurrent registrations visible', missing.length === 0, `missing ${missing.length}`)
  for (const h of holders) h.kill()
}

console.log('\n[S5] soak-lite: 2000 sends + reads, inbox scan stays fast and correct')
{
  const sid = sidOf('soak')
  const t0 = Date.now()
  for (let i = 0; i < 2000; i++) send({ toSid: sid, from: 'x', body: `soak-${i}` })
  const writeMs = Date.now() - t0
  const t1 = Date.now()
  const n = unread(sid).length
  const readMs = Date.now() - t1
  check('2000 messages all readable', n === 2000, `got ${n}`)
  check(`write throughput sane (${writeMs}ms for 2000)`, writeMs < 10000, `${writeMs}ms`)
  check(`full-inbox unread() scan under 500ms (${readMs}ms)`, readMs < 500, `${readMs}ms`)
}

console.log('\n[S6] cursor format: legacy migration and compaction')
{
  const { compactCursor } = await import('../lib/bus.mjs')
  const { writeFileSync, readFileSync } = await import('node:fs')
  const sid = sidOf('legacy')
  for (let i = 0; i < 10; i++) send({ toSid: sid, from: 'x', body: `m${i}` })
  const ids = readInbox(sid).map((m) => m.id)
  // Simulate a pre-0.5 pretty-printed cursor holding the first 5 as seen.
  writeFileSync(join(ROOT, 'cursors', `${encodeURIComponent(sid)}.json`),
    JSON.stringify({ seen: ids.slice(0, 5) }, null, 2))
  markSeen(sid, ids.slice(5, 8))  // must migrate then append, losing nothing
  check('legacy cursor migrated: old and new seen both hold', unread(sid).length === 2, `unread=${unread(sid).length}`)
  compactCursor(sid)
  const raw = readFileSync(join(ROOT, 'cursors', `${encodeURIComponent(sid)}.json`), 'utf8')
  check('compaction squashes to one line', raw.trim().split('\n').length === 1, raw)
  check('compaction preserves unread correctness', unread(sid).length === 2, `unread=${unread(sid).length}`)
}

// ---- [S7] a concurrent sweep must not unlink a LIVE server's bound socket
//
// The real bug behind a flake that presented as "session_wait doesn't wake". sweep() runs on every
// server start and used to decide from a live SNAPSHOT that costs ~210ms to build (osascript title
// refresh plus a scan of every transcript). A session that registered and bound its socket inside
// that window was missing from the snapshot and — being brand new — had no transcript either, so
// another starting server deleted its socket while it was fully alive. The victim then stays
// unreachable for live signals until it restarts: nothing recreates the path, so every send to it
// degrades to "could not reach that session's delivery socket". Real sessions have no transcript at
// startup either, so this was a production race, not a test artifact.
//
// Measured before the fix: 4 of 12 simultaneous starts lost the socket (bound ~330ms, unlinked
// ~345ms); with sweep() disabled, 12 of 12 survived.
//
// Racing two real servers reproduces it only 17-33% of the time and the rate moves with machine
// load, which makes it useless as a gate — a green run would mean nothing. So the timing dependence
// is removed instead of gambled on: a REAL server with a REAL bound socket, and the stale snapshot
// injected directly. Deterministic, and still end-to-end, because the last check proves the socket
// is not merely present but still accepting signals.
{
  const SERVER = join(HERE, '..', 'mcp', 'server.mjs')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const sid = sidOf('sweep-victim')
  const holder = spawn('sleep', ['30'])
  const proc = spawn('node', [SERVER], {
    env: {
      ...process.env,
      SESSION_BUS_SID: sid, SESSION_BUS_LABEL: 'sweepvictim', SESSION_BUS_PID: String(holder.pid),
      SESSION_BUS_BELL: '0', SESSION_BUS_NO_CHANNEL: '1',
    },
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  proc.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {} },
  }) + '\n')

  const sp = join(ROOT, 'sock', `${encodeURIComponent(sid)}.sock`)
  for (let t = 0; t < 6000 && !existsSync(sp); t += 25) await sleep(25)

  check('the victim server bound its delivery socket', existsSync(sp), sp)
  check('it is live according to its own session file', isLiveSid(sid))
  check('and it is invisible to the transcript guard (as any new session is)',
    !knownSessionIds().has(sid))

  // Exactly what another server's sweep saw: a snapshot taken before this session registered.
  const removed = sweep({ live: new Set() })
  check('a live bound socket survives a stale-snapshot sweep', existsSync(sp),
    `removed=${removed.filter((p) => p.includes(encodeURIComponent(sid))).join(',')}`)
  check('the sweep did not report it as reclaimed',
    !removed.some((p) => p.includes(encodeURIComponent(sid))), removed.join(','))

  // The property that actually matters: still reachable, not just still present on disk.
  const delivered = await signal(sid, { type: 'deliver', id: `s5-${RUN}`, from: 'stress', preview: 'x' })
  check('the session is still reachable for live signals after the sweep', delivered === true)

  try { proc.kill() } catch {}
  try { holder.kill() } catch {}
  await sleep(150)
}

// ---- cleanup
for (const sid of cleanup) {
  for (const [dir, ext] of [['msgs', '.jsonl'], ['cursors', '.json'], ['sock', '.sock'], ['sessions', '.json'], ['watchers', '.json']]) {
    const f = join(ROOT, dir, `${encodeURIComponent(sid)}${ext}`)
    try { if (existsSync(f)) unlinkSync(f) } catch {}
  }
}
console.log(`\n==== ${pass} passed, ${fail} failed ====`)
process.exit(fail ? 1 : 0)
