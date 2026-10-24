#!/usr/bin/env node
// Cold-start smoke test: a clean DSH_HOME that has never seen this plugin. It proves the
// package works on a fresh machine — boot with no store file, serve an empty atlas, accept
// a retrospective, read it back, and let the digest CLI read the same store.
//
// Run with: node test/smoke.mjs   (or: npm run smoke inside the package)

import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const home = mkdtempSync(join(tmpdir(), 'atlas-smoke-'))
process.env.DSH_HOME = home

const failures = []
function check(name, pass, detail) {
  if (pass) {
    console.log('  PASS  ' + name)
    return
  }
  failures.push(name + (detail ? ' — ' + detail : ''))
  console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : ''))
}

const routes = new Map()
const tools = new Map()
const meta = { sections: [], contexts: [] }

const { apply } = await import(new URL('../index.js', import.meta.url).href)
const fakeScope = {
  slots: { register: () => () => {}, inject: () => () => {} },
  effect: (fn) => fn(),
  on: () => () => {},
  locale: null,
  uiWorkspace: null,
  tools: null,
  systemPrompt: null,
  webServer: null,
  inject(deps, callback) {
    if (deps.includes('webServer')) {
      callback({
        effect: (fn) => fn(),
        webServer: {
          getOrigin: () => '',
          register: (route) => (routes.set(route.path, route), () => {}),
        },
      })
    }
    if (deps.includes('tools')) {
      callback({ effect: (fn) => fn(), tools: { register: (definition) => (tools.set(definition.name, definition), () => {}) } })
    }
    if (deps.includes('systemPrompt')) {
      callback({
        effect: (fn) => fn(),
        systemPrompt: {
          section: (definition) => (meta.sections.push(definition), () => {}),
          context: (definition) => (meta.contexts.push(definition), () => {}),
        },
      })
    }
  },
}

apply(fakeScope, {})

function request(path, method = 'GET', body) {
  const route = routes.get(path)
  if (!route) return Promise.resolve({ status: 0, json: null, text: '' })
  return new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = method
    req.url = path
    req.socket = { remoteAddress: '127.0.0.1' }
    req.destroy = () => {}
    let status = 0
    let text = ''
    const res = {
      writeHead: (code) => {
        status = code
      },
      setHeader: () => {},
      end: (chunk) => {
        if (chunk) text += chunk
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          json = null
        }
        resolve({ status, json, text })
      },
    }
    route.handler(req, res)
    setImmediate(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })
  })
}

console.log('\nSMOKE  (clean home: ' + home + ')')

const storePath = join(home, 'error-atlas', 'records.json')
check('no store exists yet', !existsSync(storePath))

const empty = await request('/error-atlas/data')
check('the atlas answers on an empty home', empty.status === 200 && empty.json && empty.json.stats, 'status=' + empty.status)
check('an empty atlas is empty', empty.json && empty.json.stats.total === 0 && empty.json.stats.retro === 0, JSON.stringify(empty.json && empty.json.stats))
check('the empty atlas still renders a board', empty.json && empty.json.lessons && empty.json.lessons.total === 0)
check('the tool is registered', tools.has('atlas_retro') && tools.has('atlas_lessons'), [...tools.keys()].join(','))
check('the prompt section is registered', meta.sections.some((item) => item.name === 'error-atlas:retrospective'))
check('the lesson context is registered', meta.contexts.some((item) => item.name === 'error-atlas:lessons'))
check('an empty briefing costs nothing', meta.contexts[0].text({}) === '')

const written = await request('/error-atlas/retro', 'POST', { title: 'smoke task', lesson: 'a fresh home can record a lesson' })
check('a retrospective is accepted', written.status === 200 && written.json && written.json.ok === true, JSON.stringify(written.json))
check('the store file appeared', existsSync(storePath))

const after = await request('/error-atlas/data')
check('the retrospective reads back', after.json && after.json.stats.retro === 1, JSON.stringify(after.json && after.json.stats))
check('the briefing now carries the lesson', meta.contexts[0].text({}).includes('a fresh home can record a lesson'))
check('the board counts it', after.json && after.json.lessons && after.json.lessons.total === 1)

const digest = spawnSync(process.execPath, [join(ROOT, 'bin', 'atlas-digest.mjs')], {
  env: { ...process.env, DSH_HOME: home },
  encoding: 'utf8',
})
check('the digest CLI reads the fresh store', digest.status === 0 && digest.stdout.includes('smoke task'), 'status=' + digest.status)
check('the digest CLI exits cleanly', digest.status === 0)

rmSync(home, { recursive: true, force: true })

if (failures.length > 0) {
  console.log('\nSMOKE FAILED — ' + failures.length + ' problem(s)')
  failures.forEach((item) => console.log('  - ' + item))
  process.exit(1)
}
console.log('\nSMOKE OK — a clean home boots, records, recalls and digests')
