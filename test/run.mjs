#!/usr/bin/env node
// The atlas ships its own tests. Until now every check lived in a throwaway script that
// was deleted after it passed, which means the only proof the graph still behaved was a
// memory of a green run. Run with: node test/run.mjs   (or: npm test inside the package)
//
// Deliberately dependency-free apart from React, which is borrowed from the running DSH
// profile so the client checks exercise the same renderer the panel does. When React is
// not found the client section is reported as SKIPPED, never as passed.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'

const PACKAGE = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const ROOT = PACKAGE
const HOST = join(PACKAGE, 'index.js')
const CLIENT = join(PACKAGE, 'client.js')

const results = []
let current = ''
function section(name) {
  current = name
}
function check(name, pass, detail) {
  results.push({ section: current, name, pass: Boolean(pass), detail: detail ? String(detail) : '' })
}
function eq(name, actual, expected) {
  check(name, Object.is(actual, expected), 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))
}

// ── harness ────────────────────────────────────────────────────────────────
async function bootHost(home, config = {}) {
  process.env.DSH_HOME = home
  const mod = await import('file://' + HOST.replace(/\\/g, '/') + '?t=' + Math.random())
  const handlers = new Map()
  const routes = new Map()
  const tools = []
  const sections = []
  const contexts = []
  mod.apply(
    {
      on(event, fn) {
        if (!handlers.has(event)) handlers.set(event, [])
        handlers.get(event).push(fn)
      },
      inject(deps, callback) {
        if (deps.includes('webServer')) {
          callback({
            webServer: {
              getOrigin: () => 'http://127.0.0.1:65534',
              register(route) {
                routes.set(route.path, route)
                return () => {}
              },
            },
            effect: (fn) => fn(),
          })
        }
        if (deps.includes('tools')) {
          callback({ tools: { register: (definition) => tools.push(definition) }, effect: (fn) => fn() })
        }
        if (deps.includes('systemPrompt')) {
          callback({
            systemPrompt: {
              section: (definition) => (sections.push(definition), () => {}),
              context: (definition) => (contexts.push(definition), () => {}),
            },
            effect: (fn) => fn(),
          })
        }
      },
      effect(fn) {
        fn()
      },
    },
    config,
  )
  const fire = (event, ...args) => {
    for (const fn of handlers.get(event) || []) fn(...args)
  }
  const call = async (path, method = 'GET', body) => {
    const route = routes.get(path)
    if (!route) return { status: 404, json: null }
    const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    stream.method = method
    stream.socket = { remoteAddress: '127.0.0.1' }
    const out = { status: 0, body: '' }
    await route.handler(stream, {
      writeHead(status) {
        out.status = status
      },
      end(text) {
        out.body = text || ''
      },
    })
    return { status: out.status, json: out.body ? JSON.parse(out.body) : null }
  }
  return { mod, handlers, routes, tools, sections, contexts, fire, call }
}

function tempHome(label) {
  const home = mkdtempSync(join(tmpdir(), 'atlas-test-' + label + '-'))
  mkdirSync(join(home, 'error-atlas'), { recursive: true })
  return home
}

function toolFailure(host, agent, name, filePath, message) {
  host.fire('tools/result', { name, arguments: { file_path: filePath }, agent }, { isError: true, error: { message } })
}

function toolExit(host, agent, name, arguments_, code) {
  host.fire(
    'tools/result',
    { name, arguments: arguments_, agent },
    { isError: false, value: { exitCode: code }, content: [{ type: 'text', text: '[exit code: ' + code + ']' }] },
  )
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── store ──────────────────────────────────────────────────────────────────
async function storeSection() {
  section('store')
  const home = tempHome('store')
  const host = await bootHost(home)
  const agent = { id: 'sess-store' }

  toolFailure(host, agent, 'edit', 'D:\\work\\app.js', 'file changed since it was read')
  toolFailure(host, agent, 'edit', 'D:\\work\\app.js', 'file changed since it was read')
  let data = (await host.call('/error-atlas/data')).json
  eq('repeated failure dedupes to one signature', data.nodes.filter((node) => node.kind === 'tool').length, 1)
  eq('count accumulates', data.nodes.find((node) => node.kind === 'tool').count, 2)

  host.fire('tools/result', { name: 'pwsh', arguments: { command: 'node build.js' }, agent }, { isError: false, value: { exitCode: 0 } })
  toolExit(host, agent, 'pwsh', { command: 'node build.js' }, 1)
  data = (await host.call('/error-atlas/data')).json
  eq('a non-zero exit becomes an exit signature', data.nodes.filter((node) => node.kind === 'exit').length, 1)

  host.fire('agent/error', { agent, turn: 3, step: 2, error: new Error('step exploded') })
  data = (await host.call('/error-atlas/data')).json
  eq('an agent error becomes an agent signature', data.nodes.filter((node) => node.kind === 'agent').length, 1)

  // Records are saved on a debounce, so a restart test has to let the timer fire.
  await sleep(1100)
  const again = await bootHost(home)
  const reloaded = (await again.call('/error-atlas/data')).json
  eq('records survive a restart', reloaded.stats.distinct, data.stats.distinct)
}

// ── retro ──────────────────────────────────────────────────────────────────
async function retroSection() {
  section('retro')
  const home = tempHome('retro')
  const host = await bootHost(home)
  const agent = { id: 'sess-retro' }

  toolFailure(host, agent, 'edit', 'D:\\proj\\app.js', 'boom')
  const created = await host.call('/error-atlas/retro', 'POST', { title: 'fixed the bug', lesson: 'read before write' })
  eq('a prose-only retro is accepted', created.status, 200)
  let data = (await host.call('/error-atlas/data')).json
  const retro = data.retros.find((entry) => entry.title === 'fixed the bug')
  check('the host fills the turn telemetry', retro && retro.tools.includes('edit') && retro.errorIds.length > 0, JSON.stringify(retro && { tools: retro.tools, errorIds: retro.errorIds }))
  eq('the retro links to its failure', data.links.filter((link) => link.kind === 'lesson').length, 1)

  const onDisk = JSON.parse(readFileSync(join(home, 'error-atlas', 'records.json'), 'utf8'))
  eq('a created retro is flushed before the answer', onDisk.retros.length, 1)

  // The skeleton the host writes at turn end must not duplicate a model retro written
  // during that same turn — the suppression is per turn, so a later session still gets one.
  const agent2 = { id: 'sess-retro-2' }
  host.fire('agent/inbox/claimed', { agent: agent2, message: { content: [{ type: 'text', text: 'do a coding task' }] }, turn: 9 })
  toolFailure(host, agent2, 'edit', 'D:\\proj\\app.js', 'boom again')
  host.fire('agent/turn-stopping', { agent: agent2, turn: 9 })
  data = (await host.call('/error-atlas/data')).json
  const autos = data.retros.filter((entry) => entry.auto)
  eq('a turn without a model retro still gets a skeleton', autos.length, 1)

  const upgraded = await host.call('/error-atlas/retro', 'POST', {
    id: autos[0].id,
    title: 'upgraded skeleton',
    lesson: 'a skeleton is a placeholder, not a conclusion',
  })
  eq('the skeleton upgrades in place', upgraded.status, 200)
  data = (await host.call('/error-atlas/data')).json
  const target = data.retros.find((entry) => entry.title === 'upgraded skeleton')
  check('upgraded retro is no longer auto', target && target.auto === false, JSON.stringify(target && target.auto))
  eq('upgrading does not duplicate', data.retros.length, 2)

  const missing = await host.call('/error-atlas/retro', 'POST', { title: 'no lesson' })
  eq('a new retro without a lesson is refused', missing.status, 400)
  const unknown = await host.call('/error-atlas/retro', 'POST', { id: 'r999', title: 'x', lesson: 'y' })
  eq('an unknown id is refused', unknown.status, 404)
  const wrongMethod = await host.call('/error-atlas/retro', 'GET')
  eq('the retro route is POST-only', wrongMethod.status, 405)

  const prompt = host.sections.find((entry) => entry.name === 'error-atlas:retrospective')
  eq('the prompt section keeps its order slot', prompt && prompt.order, 300)
  const promptText = prompt && typeof prompt.text === 'function' ? prompt.text({}) : prompt && prompt.text
  check('the prompt section is short', promptText && promptText.length < 500, 'length=' + (promptText && promptText.length))
  eq('the atlas_retro tool is registered', host.tools.filter((tool) => tool.name === 'atlas_retro').length, 1)
}

// ── prefs and noise ────────────────────────────────────────────────────────
async function prefsSection() {
  section('prefs')
  const home = tempHome('prefs')
  const host = await bootHost(home)
  const agent = { id: 'sess-prefs' }

  for (let i = 0; i < 3; i += 1) toolFailure(host, agent, 'edit', 'D:\\proj\\a.js', 'same noise ' + i)
  toolFailure(host, agent, 'edit', 'D:\\proj\\a.js', 'real bug')
  for (let i = 0; i < 3; i += 1) toolFailure(host, agent, 'pwsh', 'D:\\proj\\a.js', 'same noise ' + i)

  let data = (await host.call('/error-atlas/data')).json
  const before = data.stats.shown

  const saved = await host.call('/error-atlas/prefs', 'POST', { ignore: ['same noise'] })
  eq('prefs accept an ignore rule', saved.status, 200)
  data = (await host.call('/error-atlas/data')).json
  eq('the rule mutes matching signatures', data.stats.muted, 6)
  check('the atlas shrank', data.stats.shown < before, before + ' -> ' + data.stats.shown)
  check('muted signatures are counted, not hidden', data.stats.matched + data.stats.muted === data.stats.distinct, JSON.stringify({ matched: data.stats.matched, muted: data.stats.muted, distinct: data.stats.distinct }))

  const minCount = await host.call('/error-atlas/prefs', 'POST', { minCount: 2 })
  eq('minCount is clamped into range', minCount.json.prefs.minCount, 2)
  data = (await host.call('/error-atlas/data')).json
  eq('minCount hides single hits', data.stats.matched, 0)

  const reloaded = await bootHost(home)
  const persisted = (await reloaded.call('/error-atlas/prefs')).json
  check('prefs survive a restart', persisted.prefs.ignore.includes('same noise') && persisted.prefs.minCount === 2, JSON.stringify(persisted.prefs))

  const wrong = await reloaded.call('/error-atlas/prefs', 'DELETE')
  eq('prefs route rejects other methods', wrong.status, 405)

  // The two memory switches: an install can turn the prompt section and the injected
  // lessons off from the panel. Both go quiet immediately — a long-lived host must not
  // need a restart to honour a switch the user just flipped.
  const switches = await bootHost(tempHome('prefs-switch'))
  await switches.call('/error-atlas/retro', 'POST', { title: 'switch probe', lesson: 'a lesson that must be switchable off' })
  const lessonsContext = switches.contexts.find((item) => item.name === 'error-atlas:lessons')
  const reminder = switches.sections.find((item) => item.name === 'error-atlas:retrospective')
  const on = (await switches.call('/error-atlas/prefs')).json.prefs
  check('the memory switches start on', on.inject === true && on.prompt === true, JSON.stringify(on))
  check('the briefing is present before the switch', lessonsContext.text({}).includes('switchable'), lessonsContext.text({}).slice(0, 60))
  await switches.call('/error-atlas/prefs', 'POST', { inject: false })
  eq('injection off silences the briefing', lessonsContext.text({}), '')
  await switches.call('/error-atlas/prefs', 'POST', { prompt: false })
  const quiet = typeof reminder.text === 'function' ? reminder.text({}) : reminder.text
  eq('the reminder off silences the prompt section', quiet, '')
  const off = (await switches.call('/error-atlas/prefs')).json.prefs
  check('both switches persist', off.inject === false && off.prompt === false, JSON.stringify(off))
  await switches.call('/error-atlas/prefs', 'POST', { inject: true, prompt: true })
  check('turning it back on restores the briefing', lessonsContext.text({}).includes('switchable'))
}

// ── trend ──────────────────────────────────────────────────────────────────
async function trendSection() {
  section('trend')
  const HOUR = 60 * 60 * 1000
  const DAY = 24 * HOUR
  const now = Date.now()
  const home = tempHome('trend')
  writeFileSync(
    join(home, 'error-atlas', 'records.json'),
    JSON.stringify({
      version: 2,
      updatedAt: now,
      records: [{ key: 'a', id: 'e1', kind: 'tool', name: 'edit', message: 'old failure', count: 3, first: now - 2 * DAY, last: now - HOUR, sessions: [] }],
      log: [
        { at: now - HOUR, kind: 'tool', name: 'edit', message: 'old failure', count: 1 },
        { at: now - 25 * HOUR, kind: 'tool', name: 'edit', message: 'old failure', count: 1 },
        { at: now - 3 * DAY, kind: 'tool', name: 'edit', message: 'old failure', count: 1 },
        { at: now - 29 * DAY, kind: 'tool', name: 'edit', message: 'old failure', count: 1 },
        { at: now - 45 * DAY, kind: 'tool', name: 'edit', message: 'too old to plot', count: 1 },
      ],
      retros: [],
    }),
  )
  const host = await bootHost(home)
  const data = (await host.call('/error-atlas/data')).json
  const trend = data.trend
  eq('hour series is 24 wide', trend.hour.length, 24)
  eq('day series is 30 wide', trend.day.length, 30)
  eq('an hour ago lands in the previous hour bucket', trend.hour[22], 1)
  eq('the hour window drops a day-old event', trend.hour.reduce((a, b) => a + b, 0), 1)
  eq('a 3 day old event lands 3 buckets back', trend.day[26], 1)
  eq('a 29 day old event is the oldest bucket', trend.day[0], 1)
  eq('the day window drops a 45 day old event', trend.day.reduce((a, b) => a + b, 0), 4)
  eq('first-seen uses the record timestamp', trend.first[27], 1)
  check('the log is not capped in this fixture', trend.capped === false)
}

// ── project hub ────────────────────────────────────────────────────────────
async function projectSection() {
  section('project')
  const home = tempHome('project')
  const host = await bootHost(home)
  const agent = { id: 'sess-project' }
  toolFailure(host, agent, 'edit', 'D:\\deepseek\\dsh-error-atlas\\client.js', 'file changed')

  const created = await host.call('/error-atlas/retro', 'POST', {
    title: 'touched the atlas',
    lesson: 'the program is the folder the task edited',
    files: ['D:\\deepseek\\dsh-error-atlas\\client.js'],
    cwd: 'D:\\deepseek',
  })
  eq('the retro is created', created.status, 200)
  const data = (await host.call('/error-atlas/data')).json
  const projects = data.nodes.filter((node) => node.kind === 'project')
  eq('one project hub appears', projects.length, 1)
  eq('the hub is named after the folder', projects[0] && projects[0].label, 'dsh-error-atlas')
  check('the failure links to the program', data.links.some((link) => link.kind === 'project' && link.t === projects[0].id))
  eq('stats count the program', data.stats.projects, 1)

  // A file in the project root or inside node_modules is not a program.
  const flat = await bootHost(tempHome('project-flat'))
  const agent2 = { id: 'sess-flat' }
  toolFailure(flat, agent2, 'edit', 'D:\\deepseek\\package.json', 'boom')
  await flat.call('/error-atlas/retro', 'POST', {
    title: 'root level file',
    lesson: 'the root is not a program',
    files: ['D:\\deepseek\\package.json', 'D:\\deepseek\\node_modules\\x\\index.js'],
    cwd: 'D:\\deepseek',
  })
  const flatData = (await flat.call('/error-atlas/data')).json
  eq('root and vendored files make no hub', flatData.stats.projects, 0)
}

// ── export ─────────────────────────────────────────────────────────────────
async function exportSection() {
  section('export')
  const home = tempHome('export')
  const host = await bootHost(home)
  const agent = { id: 'sess-export' }
  toolFailure(host, agent, 'pwsh', 'D:\\proj\\run.js', 'exit code 1 · node run.js')
  host.fire('tools/result', { name: 'pwsh', arguments: { command: 'node run.js' }, agent }, { isError: false, value: { exitCode: 2 } })
  const created = await host.call('/error-atlas/retro', 'POST', { title: 'export me', lesson: 'exports are evidence' })
  const exported = await host.call('/error-atlas/export', 'POST')
  eq('the export route answered', exported.status, 200)
  check('the export wrote a file', exported.json && exported.json.bytes > 0, JSON.stringify(exported.json))
  const body = readFileSync(exported.json.path, 'utf8')
  check('the markdown names the task', body.includes('export me'))
  check('the markdown carries the failures', body.includes('运行时错误') && body.includes('exit'))
  check('the markdown links retros to errors', body.includes('关联错误'))
  eq('export rejects GET', (await host.call('/error-atlas/export', 'GET')).status, 405)
  eq('the export path stays inside the store dir', exported.json.path.startsWith(join(home, 'error-atlas')), true)
  eq('the retro still exists after export', created.status, 200)
}

// ── client ─────────────────────────────────────────────────────────────────
async function clientSection() {
  section('client')
  let React
  let renderToStaticMarkup
  // React comes from the running DSH profile, so the client checks exercise the same
  // renderer the panel does. The lookup is derived, never absolute: DSH_HOME wins, then
  // the conventional home, and a missing profile only skips this section.
  const homes = []
  if (process.env.DSH_HOME) homes.push(join(process.env.DSH_HOME, 'profiles', 'node_modules') + '/')
  homes.push(join(homedir(), '.dsh', 'profiles', 'node_modules') + '/')
  for (const dir of homes) {
    if (!existsSync(dir)) continue
    try {
      const local = createRequire(dir)
      React = local('react')
      renderToStaticMarkup = local('react-dom/server').renderToStaticMarkup
      break
    } catch {
      React = undefined
    }
  }
  if (!React) {
    check('client checks run (React available)', false, 'SKIPPED — React was not found in the DSH profile')
    results[results.length - 1].skipped = true
    return
  }

  const RAW = readFileSync(CLIENT, 'utf8')
  const SRC = RAW.replace(
    "    return {\n      inject: ['slots'],",
    "    return {\n      __debug: { createRenderer, isHubNode, withDev, cloudRadiusFor },\n      inject: ['slots'],",
  ).replace('useState(() => withDev(null))', 'useState(() => withDev(window.__ATLAS_SEED__))')
  check('the test seam is present', SRC.includes('__debug'))

  const now = Date.now()
  const payload = {
    generatedAt: now,
    stats: { total: 8, distinct: 5, shown: 6, matched: 5, truncated: 0, muted: 0, sessions: 1, tools: 2, projects: 1, retro: 1, stale: 1, dev: 11, byKind: {} },
    prefs: { minCount: 1, ignore: [], prompt: true, inject: false },
    trend: { hour: new Array(24).fill(0).map((_, i) => (i === 23 ? 5 : i === 21 ? 2 : 0)), day: new Array(30).fill(0).map((_, i) => (i === 29 ? 5 : 0)), first: new Array(30).fill(0).map((_, i) => (i === 29 ? 3 : 0)), hours: 24, days: 30, capped: false, events: 7 },
    nodes: [
      { id: 'root:dsh', kind: 'root', label: 'DSH', count: 9 },
      { id: 'e:e1', kind: 'tool', label: 'edit', name: 'edit', message: 'file changed since it was read', count: 3, sessions: ['sess-1'], last: now, first: now },
      { id: 'e:e2', kind: 'exit', label: 'pwsh', name: 'pwsh', message: 'exit code 1 · node build.js', count: 1, sessions: ['sess-1'], last: now, first: now },
      { id: 'p:app', kind: 'project', label: 'app', name: 'app', count: 1 },
      { id: 'rt:r1', kind: 'retro', label: 'searchable lesson', message: 'done', name: 'RETRO', count: 1, recurred: 2, retro: { id: 'r1', at: now, auto: false, title: 'searchable lesson', lesson: 'lenses beat lists', tools: ['edit'], files: ['D:/app/x.js'], errorIds: ['e1'] } },
    ],
    links: [
      { s: 'e:e1', t: 'root:dsh' },
      { s: 'e:e2', t: 'root:dsh' },
      { s: 'e:e1', t: 'p:app', kind: 'project' },
      { s: 'p:app', t: 'root:dsh' },
      { s: 'rt:r1', t: 'root:dsh' },
      { s: 'rt:r1', t: 'e:e1', kind: 'lesson' },
    ],
    lessons: {
      total: 3,
      failed: 1,
      rate: 33,
      tags: [
        { name: 'render', count: 2, failed: 1, rate: 50 },
        { name: 'test', count: 1, failed: 0, rate: 0 },
      ],
      programs: [{ name: 'app', count: 2, failed: 1, rate: 50 }],
      worst: [{ id: 'r1', at: now, title: 'searchable lesson', lesson: 'lenses beat lists', programs: ['app'], stale: 2 }],
    },
    retros: [],
    recent: [{ at: now, kind: 'tool', name: 'edit', message: 'file changed since it was read', count: 3 }],
  }

  const glStub = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'getExtension') return () => null
        if (property === 'getShaderParameter' || property === 'getProgramParameter') return () => true
        if (property === 'getShaderInfoLog' || property === 'getProgramInfoLog') return () => ''
        if (property === 'createBuffer' || property === 'createTexture') return () => ({})
        if (property === 'getAttribLocation') return () => 0
        if (property === 'getUniformLocation') return () => ({})
        if (property === 'getParameter') return () => 4096
        if (property === 'createProgram' || property === 'createShader') return () => ({})
        if (typeof property === 'string' && /^[A-Z_0-9]+$/.test(property)) return 1
        return () => undefined
      },
    },
  )
  const element = () => ({
    style: {},
    children: [],
    classList: { add() {}, remove() {} },
    setAttribute() {},
    appendChild() {},
    removeChild() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 600 }),
    addEventListener() {},
    removeEventListener() {},
    getContext: () => glStub,
    clientWidth: 900,
    clientHeight: 600,
  })
  const storage = new Map()
  const windowStub = {
    __ATLAS_SEED__: payload,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    requestAnimationFrame: (callback) => ((windowStub.__raf = callback), 1),
    cancelAnimationFrame() {},
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    devicePixelRatio: 1,
    innerWidth: 1280,
    innerHeight: 800,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    __ModuleLoader__: {
      load(descriptor) {
        windowStub.__module = descriptor
      },
    },
  }
  const documentStub = { getElementById: () => null, createElement: element, head: element(), body: element(), addEventListener() {}, visibilityState: 'visible' }
  const fetchStub = async () => ({ ok: true, json: async () => payload })

  new Function('window', 'document', 'fetch', 'console', 'queueMicrotask', SRC)(
    windowStub,
    documentStub,
    fetchStub,
    { log() {}, error() {}, warn() {} },
    (callback) => callback(),
  )
  const module = windowStub.__module.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected module ' + name)
  })
  const registered = []
  module.apply({
    slots: {
      inject: (key, callback) => callback(),
      register: (options, component) => (registered.push({ options, component }), () => {}),
    },
    effect() {},
  })

  const Panel = registered.find((entry) => entry.options.name === 'main').component
  check('the panel registers into main', Boolean(Panel))
  check('the sidebar icon registers', registered.some((entry) => entry.options.name === 'sidebar.panellist'))
  const html = renderToStaticMarkup(React.createElement(Panel, {}))
  check('the header renders the title', html.includes('ERROR ATLAS'))
  check('the build chip renders', /V\d+/.test(html))
  check('the search box renders', html.includes('type="search"'))
  check('the trend row renders 24 bars', (html.match(/class="dshea-trend-bar[ "]/g) || []).length === 24)
  check('the legend names the retrospective', html.includes('RETRO'))
  check('the legend names the program', html.includes('PROJECT'))
  check('the legend names the failed lesson', html.includes('STALE'))
  check('the lesson board renders', html.includes('dshea-board'))
  check('the lesson board names itself', html.includes('教训有效性'))
  check('the lesson board shows its rate', html.includes('33%'))
  check('the lesson board groups by tag', html.includes('按标签') && html.includes('render'))
  check('the lesson board groups by program', html.includes('按程序'))
  check('a failed tag fills its bar', /class="dshea-board-fill"[^>]*width:50%/.test(html))
  check('a clean tag uses the calm bar', html.includes('dshea-board-fill is-clean'))
  check('the canvas is mounted', html.includes('dshea-canvas'))
  check('the label switch renders', html.includes('dshea-caption'))
  check('the size dial renders', html.includes('dshea-size') && html.includes('大小'))
  check('the glow dial renders', html.includes('dshea-halo') && html.includes('光晕'))
  check('the pulse dial renders', html.includes('dshea-flow') && html.includes('光点'))
  check('the spread dial renders', html.includes('dshea-spread') && html.includes('间距'))
  check('the dials live in the look popover', html.includes('dshea-style') && html.includes('外观'))
  eq('the look popover carries all five dials', (html.match(/type="range"/g) || []).length, 5)
  check('the label switch is not the label overlay', !html.includes('dshea-btn dshea-labels'))
  check('the header draws no fill', /\.dshea-header \{[^}]*background: transparent;/.test(RAW))
  check('the paused hint is not shown by default', !html.includes('已暂停'))

  const canvasElement = element()
  const labelElement = element()
  const renderer = module.__debug.createRenderer(canvasElement, labelElement, { onHover() {}, onPick() {}, onOpen() {} })
  check('the renderer starts', renderer && renderer.ok === true)
  renderer.setData(payload)
  const state = renderer.__state()
  const chineseDev = module.__debug.withDev({}).nodes.filter((node) => node.kind === 'dev')
  check('the author defects carry both languages', chineseDev.length === 12 && /[\u4e00-\u9fa5]/.test(chineseDev[0].label), chineseDev.length + ' nodes')
  const index = new Map(state.nodes.map((node, i) => [node.id, i]))
  const hitCount = renderer.setQuery('edit')
  windowStub.__raf(1000)
  check('the memory row renders', html.includes('dshea-memory'))
  check('the memory row names its switches', html.includes('收尾提示') && html.includes('注入教训'))
  eq('an enabled switch is marked on', (html.match(/dshea-switch is-on/g) || []).length, 1)
  check('the query finds the failure', hitCount >= 1, 'hits=' + hitCount)
  check('matched nodes stay lit', state.alpha[index.get('e:e1')] > 0.9, String(state.alpha[index.get('e:e1')]))
  check('unmatched nodes fade', state.alpha[index.get('e:e2')] < 0.15, String(state.alpha[index.get('e:e2')]))
  check('retrospective text is searchable', renderer.setQuery('lenses beat lists') >= 1)
  renderer.setQuery('')
  windowStub.__raf(1016)
  check('clearing the query restores the cloud', state.alpha[index.get('e:e2')] > 0.5)
  renderer.setLabels(false)
  check('the label switch hides the captions', labelElement.style.display === 'none' && state.showLabels === false)
  renderer.setLabels(true)
  check('the label switch brings the captions back', labelElement.style.display === '' && state.showLabels === true)
  check('a program is a hub', module.__debug.isHubNode('project') === true)

  // Colour filters: switching a kind off zeroes its alpha, switching a wire role off
  // zeroes that role's link alpha, and clearing the filter restores both.
  eq('both colour filters render', (html.match(/class="dshea-colors"/g) || []).length, 2)
  check('the colour filters carry chips', (html.match(/class="dshea-chip/g) || []).length >= 10)
  const exitIdx = state.nodes.findIndex((node) => node.kind === 'exit')
  const retroIdx = state.nodes.findIndex((node) => node.kind === 'retro')
  check('the fixture carries an exit failure', exitIdx >= 0, String(exitIdx))
  renderer.setFilters(['exit'], [])
  windowStub.__raf(1032)
  check('a filtered-out kind goes dark', state.alpha[exitIdx] === 0, String(state.alpha[exitIdx]))
  check('other kinds stay lit', state.alpha[retroIdx] > 0.1, String(state.alpha[retroIdx]))
  renderer.setFilters([], [])
  windowStub.__raf(1048)
  check('clearing the kind filter restores the node', state.alpha[exitIdx] > 0.5, String(state.alpha[exitIdx]))
  const lessonLink = state.linkRoles.findIndex((role) => role === 'lesson' || role === 'stale')
  check('a lesson wire is labelled', lessonLink >= 0, String(lessonLink))
  const lessonAlpha = state.linkAlpha[lessonLink * 2]
  renderer.setFilters([], ['lesson', 'stale'])
  check('a filtered-out wire goes dark', state.linkAlpha[lessonLink * 2] === 0, String(state.linkAlpha[lessonLink * 2]))
  renderer.setFilters([], [])
  check('clearing the wire filter restores it', state.linkAlpha[lessonLink * 2] === lessonAlpha)

  // A program is a satellite, not another node in the ball: it has to settle outside
  // the error cloud while its links keep it tethered to what it produced.
  let tick = 2000
  for (let f = 0; f < 120; f += 1) {
    tick += 16.7
    if (typeof windowStub.__raf !== 'function') break
    const frame = windowStub.__raf
    windowStub.__raf = null
    frame(tick)
  }
  const radiusOf = (id) => {
    const i = index.get(id)
    return Math.hypot(state.pos[i * 3], state.pos[i * 3 + 1], state.pos[i * 3 + 2])
  }
  const projectRadius = radiusOf('p:app')
  const maxErrorRadius = Math.max(radiusOf('e:e1'), radiusOf('e:e2'))
  check('a program orbits outside the cloud', projectRadius > 45, projectRadius.toFixed(1))
  check('a program clears the errors it came from', projectRadius > maxErrorRadius + 4, projectRadius.toFixed(1) + ' vs ' + maxErrorRadius.toFixed(1))
  check('the tether survives the orbit', state.links.some((link) => link.a === index.get('e:e1') && link.b === index.get('p:app')))

  // The stage grows with the atlas: 2400 failures need a wider cloud, or the islands
  // collapse back into one ball.
  check('a small atlas keeps the old stage', module.__debug.cloudRadiusFor(240) === 34, String(module.__debug.cloudRadiusFor(240)))
  check('a large atlas widens the stage', module.__debug.cloudRadiusFor(2400) > 3 * 34, module.__debug.cloudRadiusFor(2400).toFixed(1))

  // Session windows are islands: each failure must settle nearest its own window, not the
  // window of another conversation that happened to suffer the same tool.
  const islandPayload = {
    generatedAt: now,
    stats: { total: 4, distinct: 4, shown: 7, matched: 4, truncated: 0, muted: 0, sessions: 2, tools: 2, projects: 0, retro: 0, stale: 0, dev: 0, byKind: {} },
    prefs: { minCount: 1, ignore: [], prompt: true, inject: true },
    trend: payload.trend,
    nodes: [
      { id: 'root:dsh', kind: 'root', label: 'DSH', count: 4 },
      { id: 'sessionhub:sess-a', kind: 'sessionhub', label: 'SESSION aaaa', count: 2 },
      { id: 'sessionhub:sess-b', kind: 'sessionhub', label: 'SESSION bbbb', count: 2 },
      { id: 'e:a1', kind: 'tool', label: 'edit', name: 'edit', message: 'a1', count: 1, sessions: ['sess-a'] },
      { id: 'e:a2', kind: 'exit', label: 'pwsh', name: 'pwsh', message: 'a2', count: 1, sessions: ['sess-a'] },
      { id: 'e:b1', kind: 'tool', label: 'edit', name: 'edit', message: 'b1', count: 1, sessions: ['sess-b'] },
      { id: 'e:b2', kind: 'exit', label: 'pwsh', name: 'pwsh', message: 'b2', count: 1, sessions: ['sess-b'] },
    ],
    links: [
      { s: 'e:a1', t: 'root:dsh' },
      { s: 'e:a2', t: 'root:dsh' },
      { s: 'e:b1', t: 'root:dsh' },
      { s: 'e:b2', t: 'root:dsh' },
      { s: 'e:a1', t: 'sessionhub:sess-a' },
      { s: 'e:a2', t: 'sessionhub:sess-a' },
      { s: 'e:b1', t: 'sessionhub:sess-b' },
      { s: 'e:b2', t: 'sessionhub:sess-b' },
      { s: 'sessionhub:sess-a', t: 'root:dsh' },
      { s: 'sessionhub:sess-b', t: 'root:dsh' },
    ],
    lessons: null,
    retros: [],
    recent: [],
  }
  renderer.setData(islandPayload)
  for (let f = 0; f < 150; f += 1) {
    tick += 16.7
    if (typeof windowStub.__raf === 'function') {
      const frame = windowStub.__raf
      windowStub.__raf = null
      frame(tick)
    }
  }
  const at = (id) => {
    const i = new Map(state.nodes.map((node, k) => [node.id, k])).get(id)
    return [state.pos[i * 3], state.pos[i * 3 + 1], state.pos[i * 3 + 2]]
  }
  const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
  const hubA = at('sessionhub:sess-a')
  const hubB = at('sessionhub:sess-b')
  const ownA = Math.max(near(at('e:a1'), hubA), near(at('e:a2'), hubA))
  const crossA = Math.min(near(at('e:a1'), hubB), near(at('e:a2'), hubB))
  const ownB = Math.max(near(at('e:b1'), hubB), near(at('e:b2'), hubB))
  const crossB = Math.min(near(at('e:b1'), hubA), near(at('e:b2'), hubA))
  check('window a holds its own failures', ownA < crossA, ownA.toFixed(1) + ' vs ' + crossA.toFixed(1))
  check('window b holds its own failures', ownB < crossB, ownB.toFixed(1) + ' vs ' + crossB.toFixed(1))
  check('the windows sit on different islands', near(hubA, hubB) > 8, near(hubA, hubB).toFixed(1))

  renderer.dispose()

  // The dictionary follows the DSH language setting: re-apply with an English locale and
  // the same panel must render English chrome while the Chinese default stays intact.
  const englishRegistered = []
  module.apply({
    slots: {
      inject: (key, callback) => callback(),
      register: (options, component) => (englishRegistered.push({ options, component }), () => {}),
    },
    effect() {},
    locale: { register() {}, getLocale: () => ({ active: 'en' }) },
  })
  const englishPanel = englishRegistered.find((entry) => entry.options.name === 'main').component
  const englishHtml = renderToStaticMarkup(React.createElement(englishPanel, {}))
  check('the panel follows an English locale', englishHtml.includes('Refresh') && html.includes('刷新'))
  check('the English dictionary covers the chrome', englishHtml.includes('Retrospectives') && englishHtml.includes('Programs'))
  const englishDev = module.__debug.withDev({}).nodes.filter((node) => node.kind === 'dev')
  check('the author defects switch language', englishDev.length === 12 && englishDev[0].label === 'Matrix multiply in the wrong order', englishDev[0] && englishDev[0].label)

  // Cordis throws when a service is read without being declared in `inject`. Reading the
  // optional locale / workspace that way is what crashed the real panel, so the guard has
  // to survive a context that throws on undeclared properties.
  const guarded = new Proxy(
    {
      slots: { inject: (key, callback) => callback(), register: () => () => {} },
      effect() {},
    },
    {
      get(target, property) {
        if (property in target) return target[property]
        throw new Error('cannot get property "' + String(property) + '" without inject')
      },
    },
  )
  let guardedOk = false
  let guardError = null
  try {
    module.apply(guarded)
    guardedOk = true
  } catch (error) {
    guardError = error && error.message
  }
  check('an undeclared optional service does not break apply', guardedOk, guardError)
}

// ── lessons ────────────────────────────────────────────────────────────────
// The read half. A retrospective that no later session can find is a diary entry,
// so the briefing and the lookup tool are tested like the writer is.
async function lessonSection() {
  section('lesson')

  const emptyHome = tempHome('lesson-empty')
  const emptyHost = await bootHost(emptyHome)
  const emptyContext = emptyHost.contexts.find((item) => item.name === 'error-atlas:lessons')
  check('the lesson context is registered', Boolean(emptyContext))
  eq('an empty atlas adds no prompt text', emptyContext ? emptyContext.text({}) : 'missing', '')
  eq('the lesson context sits after the retrospective rule', emptyContext ? emptyContext.order : -1, 400)

  const home = tempHome('lesson')
  const now = Date.now()
  const hour = 60 * 60 * 1000
  writeFileSync(
    join(home, 'error-atlas', 'records.json'),
    JSON.stringify({
      version: 2,
      updatedAt: now,
      records: [
        {
          key: 'tool\u0000edit\u0000boom',
          id: 'e1',
          kind: 'tool',
          name: 'edit',
          message: 'boom',
          count: 2,
          first: now - 2 * hour,
          last: now - 10 * 60 * 1000,
          sessions: ['sess-a'],
        },
      ],
      log: [
        { at: now - 12 * 60 * 1000, kind: 'tool', name: 'edit', message: 'boom', sessionId: 'sess-a' },
        { at: now - 11 * 60 * 1000, kind: 'tool', name: 'edit', message: 'boom', sessionId: 'sess-a' },
      ],
      retros: [
        {
          id: 'r1',
          at: now - hour,
          auto: false,
          title: 'fix boom',
          done: 'edited src/x.ts',
          cause: 'stale read',
          fix: 'read again',
          lesson: 'read a file right before you edit it',
          tags: ['edit'],
          tools: ['edit'],
          files: ['C:/work/proj-a/src/x.ts'],
          cwd: 'C:/work',
          errors: ['boom'],
          errorIds: ['e1'],
          sessionId: 'sess-a',
        },
        {
          id: 'r2',
          at: now - hour / 2,
          auto: false,
          title: 'second task',
          done: 'changed y',
          cause: 'why',
          fix: 'how',
          lesson: 'second lesson about caching',
          tags: ['cache'],
          tools: ['pwsh'],
          files: ['C:/work/proj-b/src/y.ts'],
          cwd: 'C:/work',
          errors: [],
          errorIds: [],
        },
      ],
    }),
  )

  const host = await bootHost(home)
  const tool = host.tools.find((item) => item.name === 'atlas_lessons')
  check('the lesson tool is registered', Boolean(tool))
  if (!tool) return

  const all = await tool.execute({})
  eq('both lessons are listed', all.total, 2)
  eq('the failed lesson sorts first', all.lessons[0].id, 'r1')
  eq('the failed lesson carries its recurrence count', all.lessons[0].stale, 2)
  check('records say which program each lesson came from', all.lessons[0].programs.includes('proj-a'), String(all.lessons[0].programs))

  const byQuery = await tool.execute({ query: 'caching' })
  eq('a text query filters the list', byQuery.total, 1)
  eq('the text query matches the right lesson', byQuery.lessons[0].id, 'r2')

  const byProgram = await tool.execute({ program: 'proj-b' })
  eq('a program filter matches the recorded program', byProgram.total, 1)
  eq('the program filter matches the right lesson', byProgram.lessons[0].id, 'r2')

  const capped = await tool.execute({ limit: 1 })
  eq('the limit caps the returned lessons', capped.lessons.length, 1)
  eq('the limit does not change the total', capped.total, 2)

  const context = host.contexts.find((item) => item.name === 'error-atlas:lessons')
  const briefing = context ? context.text({}) : ''
  check('the briefing names failed lessons as traps', briefing.includes('\u26a0 \u00d72'), briefing.slice(0, 120))
  check('the briefing quotes the recurring lesson', briefing.includes('read a file right before you edit it'))
  check('the briefing keeps recent lessons apart', briefing.includes('Recent lessons'))
  check('the briefing points at the lookup tool', briefing.includes('atlas_lessons'))
  check('the briefing stays inside a prompt-sized budget', briefing.length < 900, briefing.length)
  check('the rendered tool output reads like text', tool.output.render({}, all)[0].text.includes('2 lesson(s)'))
}


// ── board ──────────────────────────────────────────────────────────────────
// The effectiveness leaderboard: a lesson library is only useful if the reader can see
// which kinds of lesson keep failing without opening every entry.
async function boardSection() {
  section('board')
  const home = tempHome('board')
  const now = Date.now()
  const hour = 60 * 60 * 1000
  const retro = (id, at, tags, file, errorIds) => ({
    id,
    at,
    auto: false,
    title: 'task ' + id,
    done: 'changed',
    cause: 'c',
    fix: 'f',
    lesson: 'lesson ' + id,
    tags,
    tools: ['edit'],
    files: [file],
    cwd: 'C:/work',
    errors: [],
    errorIds,
  })
  writeFileSync(
    join(home, 'error-atlas', 'records.json'),
    JSON.stringify({
      version: 2,
      updatedAt: now,
      records: [
        { key: 'tool\u0000edit\u0000boom', id: 'e1', kind: 'tool', name: 'edit', message: 'boom', count: 2, first: now - 3 * hour, last: now - 10 * 60 * 1000, sessions: ['s'] },
      ],
      log: [{ at: now - 10 * 60 * 1000, kind: 'tool', name: 'edit', message: 'boom', sessionId: 's' }],
      retros: [
        retro('r1', now - 2 * hour, ['render'], 'C:/work/proj-a/src/a.ts', ['e1']),
        retro('r2', now - hour, ['render'], 'C:/work/proj-a/src/b.ts', []),
        retro('r3', now - hour / 2, ['test'], 'C:/work/proj-b/src/c.ts', []),
      ],
    }),
  )
  const host = await bootHost(home)
  const answer = await host.call('/error-atlas/data')
  eq('the data route answers', answer.status, 200)
  const board = answer.json && answer.json.lessons
  check('the payload carries a lesson board', Boolean(board))
  if (!board) return
  eq('the board counts every retrospective', board.total, 3)
  eq('the board counts failed lessons', board.failed, 1)
  eq('the board reports the failure rate', board.rate, 33)
  const render = board.tags.find((cell) => cell.name === 'render')
  check('a tag groups its lessons', Boolean(render) && render.count === 2)
  eq('a tag counts the failed lessons under it', render ? render.failed : -1, 1)
  eq('a tag reports its own rate', render ? render.rate : -1, 50)
  const clean = board.tags.find((cell) => cell.name === 'test')
  eq('a clean tag reports no failures', clean ? clean.failed : -1, 0)
  check('the board ranks programs too', board.programs.some((cell) => cell.name === 'proj-a'))
  eq('the worst lesson is the one that recurred', board.worst[0] ? board.worst[0].id : '', 'r1')
  eq('the worst lesson carries its count', board.worst[0] ? board.worst[0].stale : -1, 1)
}

// ── manifest ───────────────────────────────────────────────────────────────
async function manifestSection() {
  section('manifest')
  const PACKAGE = join(ROOT, 'package.json')
  const raw = readFileSync(PACKAGE, 'utf8')
  check('the manifest has no byte-order mark', !raw.startsWith('\uFEFF'))
  let manifest = null
  try {
    manifest = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch (error) {
    check('the manifest parses', false, String(error && error.message))
    return
  }
  check('the manifest parses', true)
  check('the version is semver', /^\d+\.\d+\.\d+$/.test(manifest.version), String(manifest.version))
  check('the bundle patch is declared', manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch === './cordis.patch.yml')
  check('the client half is declared', manifest.dsh && manifest.dsh.client && manifest.dsh.client.platform === 'web')
  check('the icon is declared', typeof manifest.icon === 'string' && manifest.icon.length > 0)

  const shipped = ['index.js', 'client.js', 'cordis.patch.yml', 'bin/atlas-retro.mjs', 'bin/atlas-digest.mjs', 'test/run.mjs', 'locale/zh.json', 'locale/en.json', manifest.icon]
  const glob = (pattern) => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$')
  for (const entry of shipped) {
    check('shipped file exists: ' + entry, existsSync(join(ROOT, entry)))
    check('shipped file is listed in files: ' + entry, Array.isArray(manifest.files) && manifest.files.some((pattern) => glob(pattern).test(entry)))
  }
  const icon = join(ROOT, manifest.icon)
  check('the icon stays under 256 KiB', existsSync(icon) && statSync(icon).size <= 256 * 1024)
  check('the exports map resolves every target', Object.entries(manifest.exports || {}).every(([key, target]) => key.includes('*') || existsSync(join(ROOT, target))))

  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  check('the patch inserts this package', patch.includes('insert:') && patch.includes("name: '" + manifest.name + "'"))

  for (const locale of ['zh', 'en']) {
    const text = readFileSync(join(ROOT, 'locale', locale + '.json'), 'utf8')
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
    check('the ' + locale + ' locale names the plugin', Boolean(parsed.meta && parsed.meta.title && parsed.meta.description))
  }
  const client = readFileSync(CLIENT, 'utf8')
  check('the client carries a build stamp', /const BUILD = 'V\d+'/.test(client))
}

// ── caps ───────────────────────────────────────────────────────────────────
async function capSection() {
  section('caps')
  const home = tempHome('caps')
  const host = await bootHost(home, { maxNodes: 3 })
  const agent = { id: 'sess-caps' }
  for (let i = 0; i < 12; i += 1) toolFailure(host, agent, 'edit', 'C:/work/proj/f' + i + '.js', 'failure ' + i)
  const small = await host.call('/error-atlas/data')
  eq('a low cap truncates', small.json.stats.truncated, 9)
  eq('a low cap keeps the requested nodes', small.json.nodes.filter((node) => node.kind === 'tool' || node.kind === 'exit').length, 3)

  // The default cap has to hold a real atlas: 260 failures used to be cut off at 240.
  const bigHome = tempHome('caps-big')
  const big = await bootHost(bigHome)
  const bigAgent = { id: 'sess-big' }
  for (let i = 0; i < 260; i += 1) toolFailure(big, bigAgent, 'edit', 'C:/work/proj/f' + i + '.js', 'failure ' + i)
  const full = await big.call('/error-atlas/data')
  eq('the default cap holds 260 failures', full.json.nodes.filter((node) => node.kind === 'tool' || node.kind === 'exit').length, 260)
  eq('the default cap hides nothing', full.json.stats.truncated, 0)
}

async function noiseSection() {
  section('noise')
  const home = tempHome('noise')
  const host = await bootHost(home)
  const agent = { id: 'sess-noise' }

  // Two different command lines that both run the same script: one signature, not two.
  host.fire('tools/result', { name: 'pwsh', arguments: { command: 'cd D:/work; & "C:/Program Files/nodejs/node.exe" build.mjs' }, agent }, {
    isError: false,
    content: [{ type: 'text', text: 'boom\n[exit code: 1]' }],
  })
  host.fire('tools/result', { name: 'pwsh', arguments: { command: 'cd D:/other; node build.mjs' }, agent }, {
    isError: false,
    content: [{ type: 'text', text: 'boom\n[exit code: 1]' }],
  })
  const first = await host.call('/error-atlas/data')
  const exits = first.json.nodes.filter((node) => node.kind === 'exit')
  eq('the shell fingerprint collapses command variants', exits.length, 1)
  check('the fingerprint names the script', /node build\.mjs/.test(exits[0].message), exits[0].message)
  check('stderr rides along as the detail', /boom/.test(exits[0].message), exits[0].message)
  eq('a described exit is not bare noise', first.json.stats.noise, 0)

  // Five identical bare exits (no stderr) are churn: hidden, counted, and swtichable.
  for (let i = 0; i < 6; i += 1) {
    host.fire('tools/result', { name: 'pwsh', arguments: { command: 'cd D:/work; node silent.mjs' }, agent }, {
      isError: false,
      content: [{ type: 'text', text: '[exit code: 1]' }],
    })
  }
  const hidden = await host.call('/error-atlas/data')
  eq('bare repeats leave the graph', hidden.json.nodes.filter((node) => /silent\.mjs/.test(node.message)).length, 0)
  check('and they are counted instead', hidden.json.stats.noise >= 1, 'noise=' + hidden.json.stats.noise)

  const shown = await host.call('/error-atlas/prefs', 'POST', { showNoise: true })
  eq('the switch is stored', shown.json.prefs.showNoise, true)
  const revealed = await host.call('/error-atlas/data')
  eq('asking for noise brings it back', revealed.json.nodes.filter((node) => /silent\.mjs/.test(node.message)).length, 1)

  // Essence is what gets injected, and a retro that arrived without one gets one derived.
  const withEssence = host.tools.find((tool) => tool.name === 'atlas_retro')
  await withEssence.execute({
    title: 'essence test',
    lesson: 'An essay-length lesson that should never reach the prompt verbatim because it is far too long to be useful in context.',
    essence: 'if a shell command fails twice -> command churn -> change the command, not the shell',
  }, { agent })
  await host.call('/error-atlas/retro', 'POST', {
    title: 'derived essence',
    lesson: '数据可视化里标签和相机距离是两个自由度',
  })
  const brief = host.contexts.find((entry) => entry.name === 'error-atlas:lessons')
  const text = brief.text({})
  check('the briefing uses the essence', /change the command, not the shell/.test(text), text.slice(0, 200))
  check('and not the essay', !/essay-length lesson/.test(text), 'leaked the essay')
  check('a missing essence is derived as a rule', /规则：/.test(text), text.slice(0, 300))
  check('the briefing stays under three lessons', (text.match(/^- /gm) || []).length <= 3, text)
}

// ── run ────────────────────────────────────────────────────────────────────
const sections = [storeSection, retroSection, prefsSection, trendSection, projectSection, exportSection, lessonSection, noiseSection, boardSection, clientSection, capSection, manifestSection]
for (const run of sections) {
  try {
    await run()
  } catch (error) {
    check('section crashed', false, error && error.stack ? error.stack.split('\n')[0] : String(error))
  }
}

let failed = 0
let skipped = 0
let lastSection = ''
for (const item of results) {
  if (item.section !== lastSection) {
    console.log('\n' + item.section.toUpperCase())
    lastSection = item.section
  }
  if (item.skipped) skipped += 1
  if (!item.pass && !item.skipped) failed += 1
  const label = item.skipped ? 'SKIP' : item.pass ? 'PASS' : 'FAIL'
  console.log('  ' + label + '  ' + item.name + (item.detail && !item.pass ? '  [' + item.detail + ']' : ''))
}
console.log('\n' + (failed === 0 ? 'OK' : 'FAILED') + ' — ' + (results.length - failed - skipped) + ' passed, ' + failed + ' failed, ' + skipped + ' skipped')
process.exitCode = failed === 0 ? 0 : 1
