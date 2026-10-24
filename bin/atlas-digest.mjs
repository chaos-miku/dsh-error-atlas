#!/usr/bin/env node
// atlas-digest: a small terminal reader for the Error Atlas store.
// Prints a compact digest of recorded runtime errors and coding retrospectives.
//
//   node bin/atlas-digest.mjs [--json] [--store=<path>] [--top=<n>]

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const wantJson = argv.includes('--json')

const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='))
  return hit ? hit.slice(name.length + 3) : fallback
}

const stamp = (ms) => {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

// East Asian glyphs take two terminal cells; everything we print is padded by
// display width, never by String#length.
const wideCode = (code) =>
  (code >= 0x1100 && code <= 0x115f) ||
  (code >= 0x2e80 && code <= 0xa4cf) ||
  (code >= 0xac00 && code <= 0xd7a3) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe30 && code <= 0xfe6f) ||
  (code >= 0xff00 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6) ||
  (code >= 0x1f300 && code <= 0x1f64f) ||
  (code >= 0x20000 && code <= 0x3fffd)

function displayWidth(text) {
  let width = 0
  for (const ch of String(text)) width += wideCode(ch.codePointAt(0)) ? 2 : 1
  return width
}

// One-line cell of exactly `width` terminal columns, ellipsised when too long.
function fit(text, width) {
  const one = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  const total = displayWidth(one)
  if (total <= width) return one + ' '.repeat(width - total)
  let out = ''
  let used = 0
  for (const ch of one) {
    const step = wideCode(ch.codePointAt(0)) ? 2 : 1
    if (used + step > width - 1) break
    out += ch
    used += step
  }
  return out + '…' + ' '.repeat(Math.max(0, width - used - 1))
}

// A terminal cell is not the same thing as a JS character: CJK glyphs occupy two
// columns, so padding by String#length leaves every Chinese row ragged.
if (argv.includes('--selftest')) {
  const cases = [
    ['DSH', 6],
    ['中文', 8],
    ['学习管线：光点沿复盘连线运行', 20],
    ['a中b', 7],
    ['中文中文中文中文', 9],
  ]
  let bad = 0
  for (const [text, width] of cases) {
    const cell = fit(text, width)
    const got = displayWidth(cell)
    if (got !== width) {
      bad += 1
      console.error('FAIL fit(' + JSON.stringify(text) + ', ' + width + ') → ' + JSON.stringify(cell) + ' width ' + got)
    } else {
      console.log('ok   fit(' + JSON.stringify(text) + ', ' + width + ')')
    }
  }
  console.log(bad ? 'SELFTEST FAILED: ' + bad : 'SELFTEST PASSED')
  process.exit(bad ? 1 : 0)
}

const storePath =
  opt('store', null) ||
  join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'error-atlas', 'records.json')
const topN = Number(opt('top', '6'))

if (!existsSync(storePath)) {
  // A fresh install has nothing to summarise yet: that is a state, not a failure.
  if (wantJson) {
    console.log(
      JSON.stringify(
        {
          store: storePath,
          version: null,
          errors: 0,
          hits: 0,
          retros: 0,
          modelRetros: 0,
          autoRetros: 0,
          staleLessons: 0,
          stale: [],
          top: [],
          recent: [],
          empty: true,
        },
        null,
        2,
      ),
    )
    process.exit(0)
  }
  console.log('')
  console.log('  ERROR ATLAS · digest')
  console.log('  ' + storePath)
  console.log('  nothing recorded yet — install the plugin in DSH, do a coding task, then run again.')
  process.exit(0)
}

// Tolerate a BOM: hand-edited stores written by PowerShell often carry one.
const store = JSON.parse(readFileSync(storePath, 'utf8').replace(/^\uFEFF/, ''))
const records = Array.isArray(store.records) ? store.records : []
const retros = Array.isArray(store.retros) ? store.retros : []
const log = Array.isArray(store.log) ? store.log : []
const hits = records.reduce((sum, r) => sum + (Number(r.count) || 0), 0)

// A lesson fails when the error it explains comes back after it was written. The same
// 90s grace window the graph uses keeps the failure that produced the lesson from
// counting as its own relapse.
const GRACE_MS = 90 * 1000
const byId = new Map(records.map((r) => [r.id, r]))
const signature = (entry) => entry.kind + '\u0000' + entry.name + '\u0000' + entry.message

// A signature many lessons point at is ambient environment noise (a shell quirk), not the
// mistake a single lesson was about; and a bare repeat without stderr carries no evidence.
const AMBIENT_REFS = 4
const refCount = new Map()
for (const retro of retros) {
  for (const id of retro.errorIds || []) refCount.set(id, (refCount.get(id) || 0) + 1)
}
const bareExit = (entry) => entry.kind === 'exit' && (entry.count || 0) >= 5 && String(entry.message || '').split(' · ').length < 3

function recurrenceOf(retro) {
  const ids = Array.isArray(retro.errorIds) ? retro.errorIds : []
  if (ids.length === 0) return null
  const cutoff = (Number(retro.at) || 0) + GRACE_MS
  const keys = new Set()
  const used = []
  let lastAt = 0
  for (const id of ids) {
    if ((refCount.get(id) || 0) >= AMBIENT_REFS) continue
    const entry = byId.get(id)
    if (!entry || bareExit(entry)) continue
    keys.add(signature(entry))
    used.push(entry)
    if ((entry.last || 0) > cutoff) lastAt = Math.max(lastAt, entry.last)
  }
  if (keys.size === 0) return null
  let times = 0
  for (const event of log) {
    if (!(event.at > cutoff)) continue
    if (!keys.has(signature(event))) continue
    times += 1
    lastAt = Math.max(lastAt, event.at)
  }
  // The log is capped; an aggregate `last` beyond the cutoff still proves a relapse.
  if (times === 0 && lastAt > 0) times = 1
  if (times === 0) return null
  const errors = used.map((entry) => ({ kind: entry.kind, name: entry.name, message: entry.message, count: entry.count }))
  return { times, lastAt, errors }
}

const failed = []
for (const retro of retros) {
  const relapse = recurrenceOf(retro)
  if (relapse) failed.push({ retro, relapse })
}
failed.sort((a, b) => b.relapse.times - a.relapse.times || b.relapse.lastAt - a.relapse.lastAt)
const staleIds = new Set(failed.map((item) => item.retro.id))

if (wantJson) {
  console.log(
    JSON.stringify(
      {
        store: storePath,
        version: store.version,
        errors: records.length,
        hits,
        retros: retros.length,
        modelRetros: retros.filter((r) => !r.auto).length,
        autoRetros: retros.filter((r) => r.auto).length,
        staleLessons: failed.length,
        stale: failed.map(({ retro, relapse }) => ({
          at: retro.at,
          auto: Boolean(retro.auto),
          title: retro.title,
          times: relapse.times,
          lastAt: relapse.lastAt,
          errors: relapse.errors,
        })),
        top: [...records].sort((a, b) => b.count - a.count).slice(0, topN).map((r) => ({
          count: r.count,
          kind: r.kind,
          name: r.name,
          message: r.message,
        })),
        recent: [...retros].sort((a, b) => b.at - a.at).slice(0, topN).map((r) => ({
          at: r.at,
          auto: Boolean(r.auto),
          title: r.title,
          errors: Array.isArray(r.errorIds) ? r.errorIds.length : (Array.isArray(r.errors) ? r.errors.length : 0),
        })),
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

const first = Math.min(...records.map((r) => r.first || r.last || 0))
const last = Math.max(...records.map((r) => r.last || r.first || 0))
const autoCount = retros.filter((r) => r.auto).length

console.log('')
console.log('  ERROR ATLAS · digest')
console.log('  ' + storePath)
console.log(
  '  span  ' + (records.length ? stamp(first) + ' → ' + stamp(last) : '—') +
    '   ·  ' + records.length + ' distinct errors  ·  ' + hits + ' hits',
)
console.log(
  '  retros  ' + retros.length + ' (' + (retros.length - autoCount) + ' model · ' + autoCount + ' auto)' +
    '   ·   ' + (failed.length ? failed.length + ' failed lesson' + (failed.length > 1 ? 's' : '') : 'every lesson held'),
)

// Read this first: a lesson that did not hold is the one thing worth looking at.
if (failed.length) {
  console.log('')
  console.log('  STALE LESSONS  (' + failed.length + ')')
  for (const { retro, relapse } of failed) {
    const target = relapse.errors[0] || { kind: '?', name: '?', message: '' }
    console.log(
      '  ' + stamp(retro.at) + '  ' + ('×' + relapse.times).padStart(3) + '  ' + fit(retro.title, 46) +
        '  ' + (retro.auto ? 'auto' : 'model'),
    )
    console.log(
      '                    ' + '最近 ' + stamp(relapse.lastAt) + '  ·  ' +
        fit(target.kind + '/' + (target.name || '?'), 18) + '  ·  ' + fit(target.message, 46),
    )
    if (relapse.errors.length > 1) {
      console.log('                    ' + '关联错误 ' + relapse.errors.length + ' 条（其余见 JSON）')
    }
  }
}

const ranked = [...records].sort((a, b) => b.count - a.count).slice(0, topN)
const widest = ranked.reduce((max, r) => Math.max(max, String(r.count).length), 1)
console.log('')
console.log('  TOP FAILURES')
for (const r of ranked) {
  const bar = '█'.repeat(Math.max(1, Math.round((r.count / ranked[0].count) * 12)))
  console.log(
    '  ' + String(r.count).padStart(widest) + '  ' + bar.padEnd(12) +
      '  ' + fit(r.kind + '/' + (r.name || '?'), 16) + '  ' + fit(r.message, 58),
  )
}

const recent = [...retros].sort((a, b) => b.at - a.at).slice(0, topN)
if (recent.length) {
  console.log('')
  console.log('  RECENT RETROSPECTIVES')
  for (const r of recent) {
    const linked = Array.isArray(r.errorIds) ? r.errorIds.length : Array.isArray(r.errors) ? r.errors.length : 0
    console.log(
      '  ' + stamp(r.at) + '  ' + (r.auto ? 'auto ' : 'model') + '  ' +
        fit(r.title, 44) + '  ' + (linked ? linked + ' linked' : '—') +
        (staleIds.has(r.id) ? '  ⚠ 失效' : ''),
    )
  }
}
console.log('')
