#!/usr/bin/env node
// atlas-retro — write a retrospective into the error atlas by hand.
//
// The atlas_retro tool only exists inside a session that was started after the plugin
// loaded; this CLI is the same thing from the outside, so a retrospective can be written
// (or an automatic skeleton upgraded) at any time.
//
//   node bin/atlas-retro.mjs --list
//   node bin/atlas-retro.mjs --upgrade r7 --cause "..." --lesson "..."
//   node bin/atlas-retro.mjs --new --title "..." --lesson "..." --done "..."
//   node bin/atlas-retro.mjs --fields retros.json     # one object or an array, UTF-8 safe
//
// --fields exists because a Chinese --cause on a Windows shell is mangled long before it
// reaches node: put the text in a JSON file and the bytes survive.
//
// It posts to the running host when possible (the host owns the store, so writing the
// JSON file underneath it would be lost on the next save) and falls back to the file
// with a warning when the host is not answering.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STORE_DIR = join(HOME, 'error-atlas')
const STORE = join(STORE_DIR, 'records.json')
const ENDPOINT = join(STORE_DIR, 'endpoint.json')

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf('--' + name)
  if (index < 0) return undefined
  const next = args[index + 1]
  return next && !next.startsWith('--') ? next : ''
}
const has = (name) => args.includes('--' + name)

function readJson(path) {
  try {
    // PowerShell's Set-Content can leave a BOM, and JSON.parse dies on it.
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

function storeOf() {
  const data = readJson(STORE)
  if (!data || !Array.isArray(data.retros)) return null
  return data
}

function stamp(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function list() {
  const data = storeOf()
  if (!data) {
    console.log('no store at ' + STORE)
    return 1
  }
  const retros = data.retros
  console.log(`${retros.length} retrospective(s) · ${STORE}`)
  for (const retro of retros) {
    const mode = retro.auto ? 'auto ' : 'model'
    const linked = Array.isArray(retro.errorIds) && retro.errorIds.length ? ` · ${retro.errorIds.length} linked` : ''
    const title = (retro.title || '(untitled)').slice(0, 52)
    console.log(`  ${retro.id.padEnd(4)} ${mode}  ${stamp(retro.at)}  ${title}${linked}`)
  }
  return 0
}

function bodyFrom(args2) {
  const body = {}
  for (const key of ['title', 'done', 'cause', 'fix', 'lesson', 'essence']) {
    const value = flag(key)
    if (typeof value === 'string' && value.trim()) body[key] = value
  }
  const tags = flag('tags')
  if (tags) body.tags = tags.split(',').map((s) => s.trim()).filter(Boolean)
  const ids = flag('ids') ?? flag('errorIds')
  if (ids) body.errorIds = ids.split(',').map((s) => s.trim()).filter(Boolean)
  const tools = flag('tools')
  if (tools) body.tools = tools.split(',').map((s) => s.trim()).filter(Boolean)
  const files = flag('files')
  if (files) body.files = files.split(',').map((s) => s.trim()).filter(Boolean)
  return body
}

// Merge into one stored record without the host: used only when the host is unavailable.
function patchFile(id, body) {
  const data = storeOf()
  if (!data) return { ok: false, error: 'no store at ' + STORE }
  const retro = data.retros.find((item) => item.id === id)
  if (!retro) return { ok: false, error: 'no retrospective ' + id }
  retro.auto = false
  for (const key of ['title', 'done', 'cause', 'fix', 'lesson', 'essence']) {
    if (typeof body[key] === 'string') retro[key] = body[key].slice(0, 420)
  }
  if (Array.isArray(body.tags)) retro.tags = body.tags.slice(0, 8)
  if (Array.isArray(body.errorIds)) retro.errorIds = body.errorIds.slice(0, 12)
  if (Array.isArray(body.tools)) retro.tools = body.tools.slice(0, 12)
  if (Array.isArray(body.files)) retro.files = body.files.slice(0, 12)
  data.updatedAt = Date.now()
  const tmp = join(dirname(STORE), 'records.json.tmp')
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, STORE)
  return { ok: true, id: retro.id, at: retro.at, via: 'file' }
}

async function post(body) {
  const endpoint = readJson(ENDPOINT)
  const port = Number(flag('port')) || (endpoint && Number(endpoint.port)) || 0
  if (!port) return { ok: false, error: 'no endpoint.json yet — restart DSH once so the host publishes its port' }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/error-atlas/retro`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    })
    const text = await response.text()
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    if (response.status === 404) {
      return { ok: false, error: 'the running host has no /error-atlas/retro route yet — restart DSH' }
    }
    if (!response.ok || !parsed || parsed.ok !== true) {
      return { ok: false, error: (parsed && parsed.error) || text.slice(0, 200) || 'HTTP ' + response.status }
    }
    return { ok: true, id: parsed.id, at: parsed.at, via: 'host' }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

const USAGE = `atlas-retro — write a retrospective into the error atlas by hand.

  node bin/atlas-retro.mjs --list
  node bin/atlas-retro.mjs --upgrade r7 --cause "..." --lesson "..."
  node bin/atlas-retro.mjs --new --title "..." --lesson "..." [--done ...] [--fix ...]
                                [--tags a,b] [--ids e1,e2] [--tools edit,pwsh] [--files x.js]
  node bin/atlas-retro.mjs --port 65203 ...     # override the published host port
  node bin/atlas-retro.mjs --fields retros.json # one record or an array of records

Fields: title, done, cause, fix, lesson, essence (text); tags (a,b); ids / errorIds (e1,e2).
An essence is the one injected line: "<if this> -> <root cause> -> <next time>"; without it
the host derives one from the lesson on the next load.
A --fields record needs "id" to upgrade an existing one, or title+lesson to create one.`

async function main() {
  if (has('help') || args.length === 0) {
    console.log(USAGE)
    return 0
  }
  if (has('list')) return list()

  const fieldsPath = flag('fields')
  let batch
  if (fieldsPath) {
    const parsed = readJson(fieldsPath)
    if (parsed === null || typeof parsed !== 'object') {
      console.error('cannot read a JSON object/array from ' + fieldsPath)
      return 2
    }
    batch = Array.isArray(parsed) ? parsed : [parsed]
    if (batch.length === 0) {
      console.error('fields file holds no records: ' + fieldsPath)
      return 2
    }
  } else {
    const upgrade = flag('upgrade')
    const body = bodyFrom(args)
    if (upgrade) body.id = upgrade
    if (!upgrade) {
      if (!body.title || !body.lesson) {
        console.error('need --title and --lesson (or --upgrade <id>)')
        return 2
      }
    } else if (Object.keys(body).length === 1) {
      console.error('--upgrade needs at least one field to write (--cause/--lesson/--done/--fix/--tags)')
      return 2
    }
    batch = [body]
  }

  let failures = 0
  for (const body of batch) {
    const upgrade = typeof body.id === 'string' && body.id ? body.id : ''
    if (!upgrade && (!body.title || !body.lesson)) {
      console.error('skipped a record without id or title+lesson: ' + JSON.stringify(body).slice(0, 90))
      failures++
      continue
    }
    const result = await post(body)
    if (result.ok) {
      console.log(`ok  ${result.id}  ${stamp(result.at)}  via ${result.via}`)
      continue
    }
    const reason = result.error || 'host unavailable'
    if (upgrade) {
      const patched = patchFile(upgrade, body)
      if (patched.ok) {
        console.error(`! host not reachable (${reason}) — wrote the store file directly.`)
        console.error('! the running host may overwrite that file on its next save: restart DSH to be safe.')
        console.log(`ok  ${patched.id}  ${stamp(patched.at)}  via ${patched.via}`)
        continue
      }
      console.error(`failed ${upgrade}: ${reason} / ${patched.error}`)
      failures++
      continue
    }
    console.error('failed: ' + reason)
    console.error('a brand-new retrospective needs the host: restart DSH so it publishes endpoint.json.')
    failures++
  }
  return failures ? 1 : 0
}

process.exitCode = await main()
