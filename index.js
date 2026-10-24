/**
 * Error Atlas — host half.
 *
 * Records the Harness' own runtime failures (agent step errors, session errors,
 * tool execution failures, failed agent config starts, non-zero process exits),
 * aggregates them, persists them under $DSH_HOME/error-atlas, and exposes two
 * loopback-only HTTP routes the Web UI half reads:
 *
 *   GET  /error-atlas/data   -> aggregated graph + recent log + retrospectives
 *   GET  /error-atlas/prefs  -> current noise rules (minCount, ignore prefixes)
 *   POST /error-atlas/prefs  -> mute noisy signatures / raise the minimum hit count
 *   POST /error-atlas/retro  -> write or upgrade a retrospective (CLI + panel)
 *   POST /error-atlas/clear  -> wipe every runtime record
 *   POST /error-atlas/export -> write every retrospective to a Markdown file
 *
 * The snapshot reports `stats.truncated` and `stats.muted` so a capped graph can never
 * present itself as complete, and every error a retrospective still references keeps its
 * node even when it fell outside `maxNodes`.
 *
 * It also keeps a retrospective log of coding tasks: the model writes one with
 * the `atlas_retro` tool, and every coding turn that ends without one still
 * leaves an automatic skeleton (tools used, files touched, errors seen) so no
 * task goes unrecorded. A global system-prompt section asks for that call, so
 * the habit applies to every session in this profile rather than one preset.
 *
 * The graph itself is rendered on the GPU by the client half; this side only
 * produces plain JSON.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'error-atlas'

const DEFAULTS = {
  maxRecords: 4000,
  maxLog: 2000,
  maxNodes: 2400,
  maxRetros: 200,
  messageChars: 260,
  retroChars: 420,
  saveDelayMs: 900,
}

const KINDS = new Set(['agent', 'session', 'tool', 'exit', 'config'])

/** Tools whose use makes a turn a coding task worth a retrospective. */
const CODING_TOOLS = new Set(['write', 'edit', 'pwsh', 'bash', 'run_code', 'plugin_manager', 'apply_patch', 'workflow'])

/**
 * Noise rules the panel and the CLI share: an error whose tool name or message starts
 * with one of these prefixes never becomes a node. `cd`/`pwd` noise is the reason this
 * exists — it would otherwise eat the node budget and pollute the relapse count.
 */
const PREF_DEFAULTS = { minCount: 1, ignore: [], prompt: true, inject: true, showNoise: false }

function normalizeIgnore(value, limit = 24) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const rule = item.replace(/\s+/g, ' ').trim()
    if (!rule || rule.length > 120) continue
    if (!out.includes(rule)) out.push(rule)
    if (out.length >= limit) break
  }
  return out
}

function isNoise(entry, ignore) {
  if (!ignore || ignore.length === 0) return false
  const name = String(entry.name || '').toLowerCase()
  const message = String(entry.message || '').toLowerCase()
  for (const rule of ignore) {
    const needle = rule.toLowerCase()
    if (name.startsWith(needle) || message.startsWith(needle) || message.includes('· ' + needle)) return true
  }
  return false
}

/** Paths that are never a standalone program: dependencies, VCS metadata, temp areas. */
const PROJECT_SKIP = /(^|[\\/])(node_modules|\.git|\.cache|AppData|Windows|Temp|tmp)([\\/]|$)/i

function canonicalPath(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
}

/**
 * The standalone program a file belongs to: the first directory under the recorded
 * working directory. A file sitting directly in the project root is not a program of
 * its own, so it yields no project rather than a hub named after the file.
 */
function projectOf(filePath, cwd) {
  const path = canonicalPath(filePath)
  if (!path || PROJECT_SKIP.test(path)) return ''
  const base = canonicalPath(cwd)
  if (base && path.toLowerCase().startsWith(base.toLowerCase() + '/')) {
    const rest = path.slice(base.length + 1).split('/').filter(Boolean)
    return rest.length > 1 ? rest[0] : ''
  }
  const parts = path.split('/').filter(Boolean)
  return parts.length >= 3 ? parts[parts.length - 2] : ''
}

function normalizeMessage(value, limit) {
  let text
  if (typeof value === 'string') text = value
  else if (value == null) text = 'unknown error'
  else if (typeof value === 'object') {
    const message = value.message
    if (typeof message === 'string' && message) text = message
    else {
      try {
        text = JSON.stringify(value)
      } catch {
        text = String(value)
      }
    }
  } else text = String(value)
  text = text.replace(/\s+/g, ' ').trim()
  if (!text) text = 'unknown error'
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text
}

/**
 * The identity of a failing command, not its whole command line.
 *
 * The shell hands us compound lines ("cd X; & node script.js"), and using that as the
 * record message split one recurring failure into dozens of near-duplicate signatures.
 * This keeps the executable, its meaningful sub command, and the script it ran.
 */
function commandFingerprint(command) {
  const KNOWN = /^(node|npm|pnpm|yarn|git|gh|rg|python|python3|pwsh|powershell|cmd|deno|bun|cargo|go|dotnet|tsc|vite|eslint|jest|vitest)$/
  const EXE = /\.(exe|cmd|bat|ps1)$/i
  const flat = String(command || '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const segments = flat
    .split(/;|&&|\|\||\n/)
    .map((part) => part.trim())
    .filter(Boolean)
  const exeOf = (segment) => {
    const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) || []
    const clean = tokens.map((token) => token.replace(/^["']|["']$/g, ''))
    const head = clean[0]
    if (!head) return null
    const bare = head.split(/[\\/]/).pop()
    const name = bare.replace(EXE, '').toLowerCase()
    if (!KNOWN.test(name)) return null
    return { name, rest: clean.slice(1) }
  }
  // The failing command is the last one in the pipeline; heredoc bodies and script
  // fragments are not commands, so walk backwards to the last real executable.
  let found = null
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const candidate = segments[i].replace(/^&\s*/, '').replace(/^@'\s*/, '')
    const parsed = exeOf(candidate)
    if (parsed) {
      found = parsed
      break
    }
  }
  if (!found) return 'shell'
  const inline = found.rest[0] || ''
  if (/^-(e|c|m)$/i.test(inline)) return found.name + ' ' + inline
  // `npm run <script>` is the useful half of a package-manager failure.
  if (/^(npm|pnpm|yarn|bun)$/.test(found.name) && found.rest[0] === 'run' && found.rest[1]) {
    return found.name + ' run ' + found.rest[1]
  }
  const qualifier = found.rest.find((token) => token && !token.startsWith('-'))
  if (!qualifier) return found.name
  const file = qualifier.split(/[\\/]/).pop()
  return found.name + ' ' + (file || qualifier)
}

/** The first useful line of stderr: the part of a failure that is not the command. */
function exitDetailOf(result) {
  const blocks = Array.isArray(result && result.content) ? result.content : []
  const lines = []
  for (const block of blocks) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue
    for (const raw of block.text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      if (/^\[exit code: -?\d+\]$/.test(line)) continue
      if (/^\[\d+ms\]$/.test(line)) continue
      lines.push(line)
    }
  }
  // stderr trails stdout, so the last meaningful line is the error itself.
  const last = lines.length > 0 ? lines[lines.length - 1] : ''
  if (!last) return ''
  return clip(last.replace(/^\s*(error|fatal|Error|FATAL):\s*/, ''), 90)
}

function summarizeArguments(args) {
  if (!args || typeof args !== 'object') return ''
  const keys = ['command', 'cmd', 'script', 'file_path', 'path', 'query', 'url', 'name']
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) {
      const line = value.trim().split('\n')[0].trim()
      return line.length > 110 ? line.slice(0, 109) + '…' : line
    }
  }
  return ''
}

/** Clip one line of text to the retrospective field budget. */
function clip(value, limit) {
  const text = typeof value === 'string' ? value : ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit - 1) + '…' : flat
}

/** The plain text of one user message, as the turn's task statement. */
function textOfMessage(message) {
  if (!message || !Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join(' ')
}

function exitCodeOf(result) {
  const blocks = Array.isArray(result && result.content) ? result.content : []
  for (const block of blocks) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue
    const match = /\[exit code: (-?\d+)\]/.exec(block.text)
    if (match) {
      const code = Number(match[1])
      if (code !== 0) return code
    }
  }
  return undefined
}

function homeRoot() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : join(homedir(), '.dsh')
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** `20261025-0031:07`-style stamp, safe for a file name on every platform. */
function fileStamp(ms) {
  const date = new Date(ms)
  return (
    date.getFullYear() + pad2(date.getMonth() + 1) + pad2(date.getDate()) +
    '-' + pad2(date.getHours()) + pad2(date.getMinutes()) + pad2(date.getSeconds())
  )
}

function cell(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()
}

function isoTime(ms) {
  try {
    return new Date(ms).toISOString()
  } catch {
    return ''
  }
}

/**
 * Turn a snapshot into a Markdown digest: retrospectives first (each with the
 * error nodes it points at), then the aggregated runtime errors. Pure function so
 * the export route and the tests share one implementation.
 */
function formatAtlasMarkdown(snapshot) {
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : []
  const links = Array.isArray(snapshot.links) ? snapshot.links : []
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const lines = []

  lines.push('# Error Atlas · 错误星图导出')
  lines.push('')
  lines.push('- 生成时间：' + isoTime(snapshot.generatedAt || Date.now()))
  lines.push('- 复盘：' + (snapshot.retros ? snapshot.retros.length : 0) + ' 条')
  lines.push('- 运行时错误：' + (snapshot.stats ? snapshot.stats.total : 0) + ' 次 / ' + (snapshot.stats ? snapshot.stats.distinct : 0) + ' 类')
  lines.push('')

  const retros = Array.isArray(snapshot.retros) ? snapshot.retros : []
  lines.push('## 任务复盘')
  lines.push('')
  retros.forEach((retro, index) => {
    lines.push('### ' + (index + 1) + '. ' + cell(retro.title) + (retro.auto ? '（宿主自动）' : ''))
    lines.push('')
    lines.push('- 时间：' + isoTime(retro.at))
    if (retro.tools && retro.tools.length) lines.push('- 工具：' + retro.tools.join(' / '))
    if (retro.files && retro.files.length) lines.push('- 文件：' + retro.files.map(cell).join(' · '))
    if (retro.done) lines.push('- 做了什么：' + cell(retro.done))
    if (retro.cause) lines.push('- 根因：' + cell(retro.cause))
    if (retro.fix) lines.push('- 解决：' + cell(retro.fix))
    if (retro.lesson) lines.push('- 教训：' + cell(retro.lesson))
    const retroNode = byId.get('rt:' + retro.id)
    if (retroNode && retroNode.recurred > 0) {
      lines.push(
        '- **教训失效**：该错误在复盘之后又出现 ' +
          retroNode.recurred +
          ' 次（最近 ' +
          isoTime(retroNode.recurredAt) +
          '）',
      )
    }
    const linked = links
      .filter((link) => link.kind === 'lesson' && link.s === 'rt:' + retro.id)
      .map((link) => byId.get(link.t))
      .filter(Boolean)
    if (linked.length) {
      lines.push('- 关联错误：')
      for (const node of linked) lines.push('  - ' + cell(node.name) + ' · ' + cell(node.message) + '（×' + (node.count || 1) + '）')
    }
    lines.push('')
  })
  if (retros.length === 0) lines.push('_（暂无复盘）_', '')

  const errors = nodes
    .filter((node) => ['agent', 'session', 'tool', 'exit', 'config', 'dev'].includes(node.kind))
    .sort((a, b) => (b.count || 0) - (a.count || 0))
  lines.push('## 运行时错误')
  lines.push('')
  if (errors.length) {
    lines.push('| 次数 | 类型 | 名称 | 消息 |')
    lines.push('| --- | --- | --- | --- |')
    for (const node of errors.slice(0, 120)) {
      lines.push('| ' + (node.count || 1) + ' | ' + cell(node.kind) + ' | ' + cell(node.name) + ' | ' + cell(node.message) + ' |')
    }
  } else {
    lines.push('_（暂无错误记录）_')
  }
  lines.push('')
  return lines.join('\n')
}

function createStore(config) {
  const dir = join(homeRoot(), 'error-atlas')
  const file = join(dir, 'records.json')
  const state = { records: new Map(), log: [], retros: [], updatedAt: 0, seq: 0, retroSeq: 0, prefs: { ...PREF_DEFAULTS } }
  let timer = null
  let writing = false

  function load() {
    try {
      if (!existsSync(file)) return
      // A UTF-8 BOM is a fatal JSON.parse token (it once sank a whole bundle), and a
      // hand-edited or PowerShell-written store is exactly where one shows up.
      const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      if (parsed && Array.isArray(parsed.records)) {
        for (const entry of parsed.records) {
          if (!entry || typeof entry.key !== 'string' || !entry.key) continue
          if (!KINDS.has(entry.kind)) continue
          state.records.set(entry.key, {
            key: entry.key,
            id: typeof entry.id === 'string' ? entry.id : 'e' + state.records.size.toString(36),
            kind: entry.kind,
            name: typeof entry.name === 'string' ? entry.name : '-',
            message: typeof entry.message === 'string' ? entry.message : 'unknown error',
            count: Number.isFinite(entry.count) ? entry.count : 1,
            first: Number.isFinite(entry.first) ? entry.first : Date.now(),
            last: Number.isFinite(entry.last) ? entry.last : Date.now(),
            sessions: Array.isArray(entry.sessions) ? entry.sessions.filter((s) => typeof s === 'string').slice(0, 12) : [],
            turn: Number.isFinite(entry.turn) ? entry.turn : 0,
            step: Number.isFinite(entry.step) ? entry.step : 0,
          })
          const seq = Number.parseInt(String(entry.id || '').replace(/^e/, ''), 36)
          if (Number.isFinite(seq) && seq > state.seq) state.seq = seq
        }
      }
      if (parsed && Array.isArray(parsed.log)) state.log = parsed.log.slice(0, config.maxLog)
      if (parsed && Array.isArray(parsed.retros)) {
        for (const entry of parsed.retros) {
          if (!entry || typeof entry.title !== 'string' || !entry.title) continue
          const retro = {
            id: typeof entry.id === 'string' && entry.id ? entry.id : 'r' + state.retros.length.toString(36),
            at: Number.isFinite(entry.at) ? entry.at : Date.now(),
            auto: entry.auto === true,
            title: clip(entry.title, 120),
            done: clip(entry.done, config.retroChars),
            cause: clip(entry.cause, config.retroChars),
            fix: clip(entry.fix, config.retroChars),
            lesson: clip(entry.lesson, config.retroChars),
            essence: clip(entry.essence, 160) || undefined,
            tags: Array.isArray(entry.tags) ? entry.tags.filter((t) => typeof t === 'string').slice(0, 8) : [],
            tools: Array.isArray(entry.tools) ? entry.tools.filter((t) => typeof t === 'string').slice(0, 12) : [],
            files: Array.isArray(entry.files) ? entry.files.filter((t) => typeof t === 'string').slice(0, 12) : [],
            errors: Array.isArray(entry.errors) ? entry.errors.filter((t) => typeof t === 'string').slice(0, 6) : [],
            errorIds: Array.isArray(entry.errorIds) ? entry.errorIds.filter((t) => typeof t === 'string').slice(0, 12) : [],
            sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : undefined,
            turn: Number.isFinite(entry.turn) ? entry.turn : 0,
            cwd: typeof entry.cwd === 'string' ? entry.cwd.slice(0, 200) : undefined,
          }
          state.retros.push(retro)
          const seq = Number.parseInt(String(retro.id).replace(/^r/, ''), 36)
          if (Number.isFinite(seq) && seq > state.retroSeq) state.retroSeq = seq
        }
        state.retros.sort((a, b) => b.at - a.at)
        if (state.retros.length > config.maxRetros) state.retros.length = config.maxRetros
      }
      if (parsed && Number.isFinite(parsed.updatedAt)) state.updatedAt = parsed.updatedAt
      // Noise preferences are part of the store, not the plugin config: they are edited
      // from the panel, so they must survive a restart without touching the YAML.
      if (parsed && parsed.prefs && typeof parsed.prefs === 'object') {
        if (Number.isFinite(parsed.prefs.minCount)) {
          state.prefs.minCount = Math.max(1, Math.min(50, Math.floor(parsed.prefs.minCount)))
        }
        if (Array.isArray(parsed.prefs.ignore)) state.prefs.ignore = normalizeIgnore(parsed.prefs.ignore)
        if (typeof parsed.prefs.showNoise === 'boolean') state.prefs.showNoise = parsed.prefs.showNoise
        if (typeof parsed.prefs.prompt === 'boolean') state.prefs.prompt = parsed.prefs.prompt
        if (typeof parsed.prefs.inject === 'boolean') state.prefs.inject = parsed.prefs.inject
      }
      let migrated = false
      // ── store v3: exit messages become command fingerprints ────────────────
      // Before this, an exit record carried the whole command line, so one recurring
      // failure arrived as dozens of near-identical signatures. Fold them once, and
      // remap every retrospective that pointed at a merged-away id.
      if (Number.isFinite(parsed.version) && parsed.version < 3) {
        const remap = new Map()
        const canonical = new Map()
        for (const entry of [...state.records.values()]) {
          if (entry.kind !== 'exit') continue
          const parts = String(entry.message || '').split(' · ')
          const code = parts[0] || 'exit code 1'
          const command = parts.slice(1).join(' · ')
          const fingerprint = commandFingerprint(command) || command
          const detail = parts.length > 2 ? parts[parts.length - 1] : ''
          const message = code + (fingerprint ? ' · ' + fingerprint : '') + (detail ? ' · ' + detail : '')
          const key = 'exit\u0000' + entry.name + '\u0000' + message
          const target = canonical.get(key)
          if (!target) {
            const merged = Object.assign({}, entry, { message, key })
            canonical.set(key, merged)
            if (merged !== entry) state.records.delete(entry.key)
            state.records.set(key, merged)
            remap.set(entry.id, merged.id)
            continue
          }
          target.count += entry.count
          target.first = Math.min(target.first, entry.first)
          target.last = Math.max(target.last, entry.last)
          for (const session of entry.sessions || []) {
            if (target.sessions.length < 12 && !target.sessions.includes(session)) target.sessions.push(session)
          }
          state.records.delete(entry.key)
          remap.set(entry.id, target.id)
        }
        const alive = new Set([...state.records.values()].map((entry) => entry.id))
        for (const retro of state.retros) {
          if (!Array.isArray(retro.errorIds) || retro.errorIds.length === 0) continue
          const next = []
          for (const id of retro.errorIds) {
            const mapped = remap.get(id) || id
            if (alive.has(mapped) && !next.includes(mapped)) next.push(mapped)
          }
          retro.errorIds = next.slice(0, 12)
        }
        migrated = true
      }

      for (const retro of state.retros) {
        if (!retro.essence) {
          const derived = deriveEssence(retro)
          if (derived) {
            retro.essence = clip(derived, 160)
            migrated = true
          }
        }
      }
      if (migrated) save()
      // A store written before lesson links existed carries only failure text on its
      // retrospectives; give those pipelines back once.
      if (state.retros.length > 0 && state.records.size > 0) {
        if (backfillLessonLinks() > 0) scheduleSave()
      }
    } catch {
      // A corrupt store must never take the Harness down: start empty.
      state.records.clear()
      state.log = []
    }
  }

  function save() {
    if (writing) return
    writing = true
    try {
      mkdirSync(dir, { recursive: true })
      const payload = JSON.stringify({
        version: 3,
        updatedAt: state.updatedAt,
        records: [...state.records.values()],
        log: state.log,
        retros: state.retros,
        prefs: state.prefs,
      })
      const temp = file + '.tmp'
      writeFileSync(temp, payload, 'utf8')
      renameSync(temp, file)
    } catch {
      // Persistence is best effort; the in-memory graph keeps working.
    } finally {
      writing = false
    }
  }

  // Retrospectives written before lesson links existed carry only the failure text
  // (clipped to the current limit). Match that text back to a stored record so their
  // pipelines show up too; runs once at load, and the result is persisted.
  const errorTextKey = (text) =>
    clip(text, 400)
      .replace(/…+$/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()

  function backfillLessonLinks() {
    const pool = [...state.records.values()]
    let filled = 0
    for (const retro of state.retros) {
      if (retro.errorIds.length > 0 || retro.errors.length === 0) continue
      const ids = []
      for (const text of retro.errors) {
        const needle = errorTextKey(text)
        if (needle.length < 8) continue
        const hit = pool.find((record) => {
          const hay = errorTextKey(record.message)
          return hay === needle || hay.startsWith(needle) || needle.startsWith(hay)
        })
        if (hit && !ids.includes(hit.id)) ids.push(hit.id)
      }
      if (ids.length > 0) {
        retro.errorIds = ids.slice(0, 12)
        filled += 1
      }
    }
    return filled
  }

  function scheduleSave() {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      state.updatedAt = Date.now()
      save()
    }, config.saveDelayMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  function evict() {
    if (state.records.size <= config.maxRecords) return
    const ordered = [...state.records.values()].sort((a, b) => a.last - b.last)
    const drop = state.records.size - config.maxRecords
    for (let i = 0; i < drop; i += 1) state.records.delete(ordered[i].key)
  }

  function record(input) {
    const at = Date.now()
    const kind = KINDS.has(input.kind) ? input.kind : 'agent'
    const toolName = typeof input.name === 'string' && input.name ? input.name.slice(0, 80) : '-'
    const message = normalizeMessage(input.message, config.messageChars)
    const sessionId = input.sessionId ? String(input.sessionId) : undefined
    const key = kind + '\u0000' + toolName + '\u0000' + message

    let entry = state.records.get(key)
    if (!entry) {
      state.seq += 1
      entry = {
        key,
        id: 'e' + state.seq.toString(36),
        kind,
        name: toolName,
        message,
        count: 0,
        first: at,
        last: at,
        sessions: [],
        turn: 0,
        step: 0,
      }
      state.records.set(key, entry)
    }
    entry.count += 1
    entry.last = at
    if (Number.isFinite(input.turn)) entry.turn = input.turn
    if (Number.isFinite(input.step)) entry.step = input.step
    if (sessionId && entry.sessions.length < 12 && !entry.sessions.includes(sessionId)) {
      entry.sessions.push(sessionId)
    }

    state.log.unshift({
      at,
      kind,
      name: toolName,
      message,
      sessionId: sessionId || null,
      turn: Number.isFinite(input.turn) ? input.turn : null,
      step: Number.isFinite(input.step) ? input.step : null,
      count: entry.count,
    })
    if (state.log.length > config.maxLog) state.log.length = config.maxLog

    evict()
    scheduleSave()
    return entry
  }

  // Retire in order: auto skeletons first, then the oldest model-written records.
  // A retro the model actually wrote outlives the bookkeeping ones.
  function trimRetros() {
    if (state.retros.length <= config.maxRetros) return
    const auto = state.retros.filter((retro) => retro.auto)
    for (let i = auto.length - 1; i >= 0 && state.retros.length > config.maxRetros; i -= 1) {
      const index = state.retros.indexOf(auto[i])
      if (index >= 0) state.retros.splice(index, 1)
    }
    if (state.retros.length > config.maxRetros) state.retros.length = config.maxRetros
  }

  /** A lesson is only worth injecting if it says what to do next, in one line. */
  function deriveEssence(retro) {
    const raw = String((retro && (retro.essence || retro.lesson)) || '').trim()
    if (!raw) return ''
    const flat = raw.replace(/\s+/g, ' ')
    const trimmed = flat.length > 96 ? flat.slice(0, 95) + '…' : flat
    return /→/.test(trimmed) || /^(如果|当|别|不要|先|记得|用|把|每次|任何|永远|写|改|加|删|查|量|先量)/.test(trimmed)
      ? trimmed
      : '规则：' + trimmed
  }

  function addRetro(input) {
    const at = Date.now()
    state.retroSeq += 1
    const retro = {
      id: 'r' + state.retroSeq.toString(36),
      at,
      auto: input.auto === true,
      essence: clip(input.essence || '', 160) || undefined,
      title: clip(input.title, 120) || '未命名任务',
      done: clip(input.done, config.retroChars),
      cause: clip(input.cause, config.retroChars),
      fix: clip(input.fix, config.retroChars),
      lesson: clip(input.lesson, config.retroChars),
      tags: (Array.isArray(input.tags) ? input.tags : []).filter((t) => typeof t === 'string').slice(0, 8),
      tools: (Array.isArray(input.tools) ? input.tools : []).filter((t) => typeof t === 'string').slice(0, 12),
      files: (Array.isArray(input.files) ? input.files : []).filter((t) => typeof t === 'string').slice(0, 12),
      errors: (Array.isArray(input.errors) ? input.errors : []).filter((t) => typeof t === 'string').slice(0, 6),
      errorIds: (Array.isArray(input.errorIds) ? input.errorIds : []).filter((t) => typeof t === 'string').slice(0, 12),
      sessionId: input.sessionId ? String(input.sessionId) : undefined,
      turn: Number.isFinite(input.turn) ? input.turn : 0,
      cwd: typeof input.cwd === 'string' ? input.cwd.slice(0, 200) : undefined,
    }
    state.retros.unshift(retro)
    trimRetros()
    state.updatedAt = at
    scheduleSave()
    return retro
  }

  // A skeleton the host wrote is worth keeping only until someone can explain it. The
  // model (or the atlas-retro CLI) rewrites the same record with real content: same id,
  // richer fields, auto cleared so the record stops being bookkeeping.
  function upsertRetro(input) {
    const id = typeof input.id === 'string' ? input.id : ''
    const existing = id ? state.retros.find((retro) => retro.id === id) : undefined
    if (!existing) {
      const created = addRetro(input)
      // A create over HTTP is a promise as well: flush it before the route answers,
      // so a reader that polls the store right after the response sees the record.
      save()
      return created
    }
    const pick = (value, fallback, limit) =>
      typeof value === 'string' && value.trim() ? clip(value, limit) : fallback
    const list = (value, fallback, max) =>
      Array.isArray(value)
        ? value.filter((item) => typeof item === 'string' && item).slice(0, max)
        : fallback
    existing.auto = false
    existing.title = pick(input.title, existing.title, 120)
    existing.done = pick(input.done, existing.done, config.retroChars)
    existing.cause = pick(input.cause, existing.cause, config.retroChars)
    existing.fix = pick(input.fix, existing.fix, config.retroChars)
    existing.lesson = pick(input.lesson, existing.lesson, config.retroChars)
    existing.essence = pick(input.essence, existing.essence, 160)
    existing.tags = list(input.tags, existing.tags, 8)
    existing.tools = list(input.tools, existing.tools, 12)
    existing.files = list(input.files, existing.files, 12)
    existing.errors = list(input.errors, existing.errors, 6)
    existing.errorIds = list(input.errorIds, existing.errorIds, 12)
    state.updatedAt = Date.now()
    // An HTTP write is a promise: persist before answering, not on the save debounce.
    save()
    return existing
  }

  // The skeleton check: a model-written retrospective dated inside the running turn means
  // the turn already explained itself, whichever channel wrote it.
  function modelRetroSince(since) {
    const from = Number.isFinite(since) ? since : 0
    return state.retros.some((retro) => !retro.auto && retro.at >= from)
  }

  function hasRetro(id) {
    return state.retros.some((retro) => retro.id === id)
  }

  // The panel and the CLI change noise rules through a route; persist immediately so a
  // restart cannot resurrect the nodes the user just muted.
  function prefs() {
    return {
      minCount: state.prefs.minCount,
      ignore: [...state.prefs.ignore],
      prompt: state.prefs.prompt,
      inject: state.prefs.inject,
      showNoise: state.prefs.showNoise,
    }
  }

  function applyPrefs(patch) {
    if (!patch || typeof patch !== 'object') return prefs()
    if (Number.isFinite(patch.minCount)) {
      state.prefs.minCount = Math.max(1, Math.min(50, Math.floor(patch.minCount)))
    }
    if (Array.isArray(patch.ignore)) state.prefs.ignore = normalizeIgnore(patch.ignore)
    if (typeof patch.prompt === 'boolean') state.prefs.prompt = patch.prompt
    if (typeof patch.inject === 'boolean') state.prefs.inject = patch.inject
    if (typeof patch.showNoise === 'boolean') state.prefs.showNoise = patch.showNoise
    state.updatedAt = Date.now()
    save()
    return prefs()
  }

  /**
   * A failure whose only evidence is the exit code, repeated enough times to be churn.
   * Real failures bring stderr with them; bare repeats are the "same command failed
   * again" noise that used to drown the graph and poison lesson staleness.
   */
  function isBareExit(entry) {
    if (!entry || entry.kind !== 'exit') return false
    if (entry.count < 5) return false
    const segments = String(entry.message || '').split(' · ')
    return segments.length < 3
  }

  function clear() {
    state.records.clear()
    state.log = []
    state.updatedAt = Date.now()
    save()
  }

  // A lesson can fail. When the very error a retrospective learned from shows up again
  // after the lesson was written, the lesson did not hold. The failure that produced the
  // retrospective is excluded by a grace window so a lesson never counts as its own relapse.
  const RETRO_GRACE_MS = 90 * 1000

  function recurrenceOf(retro, recordById) {
    const ids = Array.isArray(retro.errorIds) ? retro.errorIds : []
    if (ids.length === 0) return null
    const cutoff = (Number(retro.at) || 0) + RETRO_GRACE_MS
    const keys = new Set()
    let lastAt = 0
    for (const id of ids) {
      const entry = recordById.get(id)
      if (!entry) continue
      keys.add(entry.key)
      if (entry.last > cutoff) lastAt = Math.max(lastAt, entry.last)
    }
    if (keys.size === 0) return null
    let times = 0
    // The log is newest-first, so the first event at or before the cutoff ends the scan.
    for (const ev of state.log) {
      if (!(ev.at > cutoff)) break
      if (keys.has(ev.kind + '\u0000' + ev.name + '\u0000' + ev.message)) {
        times += 1
        lastAt = Math.max(lastAt, ev.at)
      }
    }
    // The log is capped, so a recurrence that only survives as an aggregate still counts.
    if (times === 0 && lastAt > 0) times = 1
    if (times === 0) return null
    return { times, lastAt }
  }

  // Trend bars answer "when do failures happen" without lying about the past: the
  // event log is capped (maxLog), so hour/day counts are a lower bound, while the
  // per-day first-seen counts come from the records and are exact for what is stored.
  const TREND_HOURS = 24
  const TREND_DAYS = 30

  function trendOf(now) {
    const hour = new Array(TREND_HOURS).fill(0)
    const day = new Array(TREND_DAYS).fill(0)
    const first = new Array(TREND_DAYS).fill(0)
    const hourMs = 60 * 60 * 1000
    const dayMs = 24 * hourMs
    for (const event of state.log) {
      const age = now - event.at
      if (!(age >= 0)) continue
      if (age < hourMs * TREND_HOURS) hour[TREND_HOURS - 1 - Math.floor(age / hourMs)] += 1
      if (age < dayMs * TREND_DAYS) day[TREND_DAYS - 1 - Math.floor(age / dayMs)] += 1
    }
    for (const entry of state.records.values()) {
      const age = now - entry.first
      if (!(age >= 0) || age >= dayMs * TREND_DAYS) continue
      first[TREND_DAYS - 1 - Math.floor(age / dayMs)] += 1
    }
    return {
      hour,
      day,
      first,
      hours: TREND_HOURS,
      days: TREND_DAYS,
      // True when the bars cannot show everything: the log hit its cap.
      capped: state.log.length >= config.maxLog,
      events: state.log.length,
    }
  }

    // The read side. A retrospective only pays off if the next session can find it,
    // so lessons get their own accessors instead of riding on the snapshot, which is
    // shaped for pixels rather than tokens.
    function lessonList(query) {
      const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
      const recordById = new Map()
      for (const entry of state.records.values()) recordById.set(entry.id, entry)
      const lessons = []
      for (const retro of state.retros) {
        const relapse = recurrenceOf(retro, recordById)
        const programs = []
        for (const file of retro.files || []) {
          const project = projectOf(file, retro.cwd)
          if (project && !programs.includes(project)) programs.push(project)
        }
        const haystack = [
          retro.title,
          retro.done,
          retro.cause,
          retro.fix,
          retro.lesson,
          ...(retro.tags || []),
          ...programs,
          ...(retro.tools || []),
        ]
          .join(' ')
          .toLowerCase()
        if (needle && !haystack.includes(needle)) continue
        lessons.push({
          id: retro.id,
          at: retro.at,
          auto: !!retro.auto,
          title: retro.title,
          essence: retro.essence || deriveEssence(retro),
          lesson: retro.lesson || '',
          cause: retro.cause || '',
          fix: retro.fix || '',
          tags: (retro.tags || []).slice(0, 6),
          programs: programs.slice(0, 3),
          tools: (retro.tools || []).slice(0, 6),
          errorIds: (retro.errorIds || []).slice(0, 12),
          // Non-zero: the lesson was written, and the error it explains still recurred.
          stale: relapse ? relapse.times : 0,
          staleAt: relapse ? relapse.lastAt : 0,
        })
      }
      lessons.sort((a, b) => b.stale - a.stale || b.at - a.at)
      return lessons
    }

    // What goes into the prompt every step must earn its characters, so the briefing
    // carries at most three failed lessons plus the freshest few, and nothing at all
    // when the atlas is empty.
    function lessonBriefing(limit = 4) {
      // Switched off in the panel: an empty string makes the context section vanish, so
      // a user who does not want injected lessons pays nothing per request.
      if (state.prefs.inject === false) return ''
      // Auto skeletons are bookkeeping, not lessons learned: they never make it in.
      const lessons = lessonList().filter((item) => !item.auto)
      if (lessons.length === 0) return ''
      // Two traps plus two fresh rules is about the most a model will actually use;
      // the full text stays one tool call away.
      // Only a lesson that points at a real error can be disproved; a skeleton without
      // errorIds can never come back, so it can never be a trap either.
      const stale = lessons.filter((item) => item.stale > 0 && item.errorIds.length > 0).slice(0, 1)
      const recent = lessons
        .filter((item) => item.stale === 0)
        .slice(0, Math.max(1, limit - stale.length))
      const line = (item, prefix) => {
        const where = item.programs.length > 0 ? '[' + item.programs[0] + '] ' : ''
        // Essence, not the essay: one actionable line per lesson, so three of them fit
        // in the same budget the old five-paragraph version used.
        const text = clip(item.essence || item.lesson || item.title, 110)
        return '- ' + prefix + where + text
      }
      const lines = ['## Error atlas: recorded lessons']
      if (stale.length > 0) {
        lines.push('These were written down and the same error came back anyway — known traps, not advice:')
        for (const item of stale) lines.push(line(item, '⚠ ×' + item.stale + ' '))
      }
      if (recent.length > 0) {
        if (stale.length > 0) lines.push('Recent lessons:')
        for (const item of recent) lines.push(line(item, ''))
      }
      lines.push('Call `atlas_lessons` for the full list, optionally filtered by program or tool.')
      return lines.join('\n')
    }

  function snapshot() {
    const all = [...state.records.values()].sort((a, b) => b.count - a.count || b.last - a.last)
    const recordById = new Map()
    for (const entry of all) recordById.set(entry.id, entry)
    // Muted signatures still feed relapse detection (a lesson that failed on a noisy
    // command is still a failed lesson), they just do not become nodes.
    const noisy = all.filter((entry) => isBareExit(entry))
    const quiet = state.prefs.showNoise ? all : all.filter((entry) => !isBareExit(entry))
    const visible = quiet.filter(
      (entry) => entry.count >= state.prefs.minCount && !isNoise(entry, state.prefs.ignore),
    )
    const muted = all.length - visible.length
    const byKind = { agent: 0, session: 0, tool: 0, exit: 0, config: 0 }
    let total = 0
    for (const entry of visible) {
      total += entry.count
      byKind[entry.kind] = (byKind[entry.kind] || 0) + entry.count
    }

    // Recurrence is judged against what the graph actually shows, so muting a noisy
    // signature also stops it from flagging healthy lessons as failed.
    recordById.clear()
    for (const entry of visible) recordById.set(entry.id, entry)

    const picked = visible.slice(0, config.maxNodes)
    // A retrospective must never point at a node the cap dropped: its lesson edge would
    // vanish and the atlas would quietly claim that every lesson held. Reserve the space.
    const referenced = new Set()
    for (const retro of state.retros) {
      for (const id of retro.errorIds || []) referenced.add('e:' + id)
    }
    if (referenced.size > 0) {
      const present = new Set(picked.map((entry) => 'e:' + entry.id))
      for (const entry of visible.slice(config.maxNodes)) {
        const nodeId = 'e:' + entry.id
        if (!present.has(nodeId) && referenced.has(nodeId)) picked.push(entry)
      }
    }
    const truncated = visible.length - picked.length
    const nodes = []
    const links = []
    const seen = new Set()

    const addNode = (node) => {
      if (seen.has(node.id)) return
      seen.add(node.id)
      nodes.push(node)
    }

    for (const entry of picked) {
      addNode({
        id: 'e:' + entry.id,
        kind: entry.kind,
        label: entry.name === '-' ? entry.message : entry.name,
        message: entry.message,
        name: entry.name,
        count: entry.count,
        last: entry.last,
        first: entry.first,
        turn: entry.turn,
        step: entry.step,
        sessions: entry.sessions.slice(0, 4),
      })
    }

    const toolTotals = new Map()
    const sessionTotals = new Map()
    for (const entry of picked) {
      if (entry.kind === 'tool' || entry.kind === 'exit') {
        toolTotals.set(entry.name, (toolTotals.get(entry.name) || 0) + entry.count)
      }
      for (const sessionId of entry.sessions) {
        sessionTotals.set(sessionId, (sessionTotals.get(sessionId) || 0) + 1)
      }
    }

    for (const [toolName, count] of toolTotals) {
      addNode({ id: 't:' + toolName, kind: 'toolhub', label: toolName, name: toolName, count })
    }
    for (const [sessionId, count] of sessionTotals) {
      addNode({
        id: 's:' + sessionId,
        kind: 'sessionhub',
        label: 'SESSION ' + sessionId.slice(-6),
        sessionId,
        count,
      })
    }

    const linked = new Set()
    for (const entry of picked) {
      const errorId = 'e:' + entry.id
      if ((entry.kind === 'tool' || entry.kind === 'exit') && toolTotals.has(entry.name)) {
        const hubId = 't:' + entry.name
        const key = errorId + '>' + hubId
        if (!linked.has(key)) {
          linked.add(key)
          links.push({ s: errorId, t: hubId })
        }
      }
      for (const sessionId of entry.sessions.slice(0, 2)) {
        if (!sessionTotals.has(sessionId)) continue
        const hubId = 's:' + sessionId
        const key = errorId + '>' + hubId
        if (!linked.has(key)) {
          linked.add(key)
          links.push({ s: errorId, t: hubId })
        }
      }
    }

    // A standalone program gets its own hub. A retrospective records the files it
    // touched, and those files say which program the failures belong to: that is a
    // different axis from the tool hub (which tool) and the session hub (which window).
    // Only projects that actually contain a failure earn a node — an empty hub is noise.
    const projectErrors = new Map()
    for (const retro of state.retros.slice(0, config.maxRetros)) {
      let project = ''
      for (const file of retro.files || []) {
        project = projectOf(file, retro.cwd)
        if (project) break
      }
      if (!project) continue
      const bucket = projectErrors.get(project) || new Set()
      for (const errorId of retro.errorIds || []) {
        if (seen.has('e:' + errorId)) bucket.add(errorId)
      }
      projectErrors.set(project, bucket)
    }
    for (const [project, errorIds] of projectErrors) {
      if (errorIds.size === 0) continue
      const hubId = 'p:' + project
      addNode({ id: hubId, kind: 'project', label: project, name: project, count: errorIds.size })
      for (const errorId of errorIds) {
        const key = 'e:' + errorId + '>' + hubId
        if (linked.has(key)) continue
        linked.add(key)
        links.push({ s: 'e:' + errorId, t: hubId, kind: 'project' })
      }
    }

    // Retrospectives join the same cloud: one node per recorded coding task,
    // anchored to the DSH core like every other leaf.
    const retroNodes = []
    for (const retro of state.retros.slice(0, config.maxRetros)) {
      const relapse = recurrenceOf(retro, recordById)
      retroNodes.push({
        id: 'rt:' + retro.id,
        kind: 'retro',
        label: retro.title,
        message: retro.done || retro.title,
        name: retro.auto ? 'AUTO RETRO' : 'RETRO',
        count: 1,
        first: retro.at,
        last: retro.at,
        turn: retro.turn,
        // A non-zero count means: this lesson was learned, and the mistake still came back.
        recurred: relapse ? relapse.times : 0,
        recurredAt: relapse ? relapse.lastAt : 0,
        retro,
      })
    }

    // The DSH core sits at the centre of the atlas: every hub, and every error that
    // has no hub, is anchored to it so the cloud always has a middle to orbit.
    if (nodes.length > 0 || retroNodes.length > 0) {
      addNode({ id: 'root:dsh', kind: 'root', label: 'DSH', count: total + retroNodes.length })
      for (const node of nodes) {
        if (node.kind === 'toolhub' || node.kind === 'sessionhub' || node.kind === 'project') {
          links.push({ s: node.id, t: 'root:dsh' })
        }
      }
      const anchored = new Set()
      for (const link of links) {
        anchored.add(link.s)
        anchored.add(link.t)
      }
      for (const node of nodes) {
        if (node.kind === 'root' || anchored.has(node.id)) continue
        links.push({ s: node.id, t: 'root:dsh' })
      }
      for (const node of retroNodes) {
        addNode(node)
        links.push({ s: node.id, t: 'root:dsh' })
        // The lesson points at the failures it came from: a dashed "lesson" edge to
        // every error node still present in this snapshot.
        for (const errorId of node.retro.errorIds || []) {
          const target = 'e:' + errorId
          if (!seen.has(target)) continue
          links.push({ s: node.id, t: target, kind: 'lesson' })
        }
      }
    }

    // Lesson effectiveness: the only honest measure of whether this atlas teaches
    // anything. A lesson whose error came back is a failure of the lesson, not of the
    // record, so the rates are grouped by the labels a reader would actually use.
    function lessonBoard() {
      const recordById = new Map()
      for (const entry of state.records.values()) recordById.set(entry.id, entry)
      const tags = new Map()
      const programs = new Map()
      const failedRows = []
      let total = 0
      const bump = (bucket, name, stale) => {
        const cell = bucket.get(name) || { name, count: 0, failed: 0 }
        cell.count += 1
        if (stale > 0) cell.failed += 1
        bucket.set(name, cell)
      }
      for (const retro of state.retros) {
        const relapse = recurrenceOf(retro, recordById)
        const stale = relapse ? relapse.times : 0
        total += 1
        const retroPrograms = []
        for (const file of retro.files || []) {
          const project = projectOf(file, retro.cwd)
          if (project && !retroPrograms.includes(project)) retroPrograms.push(project)
        }
        for (const tag of retro.tags || []) bump(tags, tag, stale)
        for (const program of retroPrograms) bump(programs, program, stale)
        if (stale > 0) {
          failedRows.push({
            id: retro.id,
            at: retro.at,
            title: retro.title,
            lesson: retro.lesson || retro.done || retro.title,
            programs: retroPrograms.slice(0, 3),
            stale,
          })
        }
      }
      const ranked = (bucket, limit) =>
        [...bucket.values()]
          .sort((a, b) => b.failed - a.failed || b.count - a.count || a.name.localeCompare(b.name))
          .slice(0, limit)
          .map((cell) => ({
            name: cell.name,
            count: cell.count,
            failed: cell.failed,
            rate: cell.count > 0 ? Math.round((cell.failed / cell.count) * 100) : 0,
          }))
      failedRows.sort((a, b) => b.stale - a.stale || b.at - a.at)
      return {
        total,
        failed: failedRows.length,
        rate: total > 0 ? Math.round((failedRows.length / total) * 100) : 0,
        tags: ranked(tags, 8),
        programs: ranked(programs, 6),
        worst: failedRows.slice(0, 5),
      }
    }

    return {
      generatedAt: Date.now(),
      updatedAt: state.updatedAt,
      stats: {
        total,
        distinct: state.records.size,
        shown: nodes.length,
        // Honesty about the cap: without these two numbers a truncated atlas looks
        // complete, and a lesson whose edge was cut looks like it held.
        matched: visible.length,
        truncated,
        muted,
        // Bare repeats the graph hides by default; a non-zero count explains the gap
        // between distinct and matched instead of leaking it silently.
        noise: noisy.length,
        sessions: sessionTotals.size,
        tools: toolTotals.size,
        projects: [...projectErrors.values()].filter((set) => set.size > 0).length,
        retro: retroNodes.length,
        // Lessons that did not hold: the error they explain came back anyway.
        stale: retroNodes.filter((node) => node.recurred > 0).length,
        byKind,
      },
      prefs: prefs(),
      trend: trendOf(Date.now()),
      lessons: lessonBoard(),
      nodes,
      links,
      retros: state.retros.slice(0, config.maxRetros),
      recent: state.log.slice(0, 200),
    }
  }

  load()

  return {
    record,
    addRetro,
    upsertRetro,
    modelRetroSince,
    hasRetro,
    clear,
    snapshot,
    prefs,
    applyPrefs,
    lessonList,
    lessonBriefing,
  }
}

function isLoopback(req) {
  const address = (req.socket && req.socket.remoteAddress) || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address === ''
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(json),
  })
  res.end(json)
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        finish(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        finish(null)
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        finish(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null)
      } catch {
        finish(null)
      }
    })
    req.on('error', () => finish(null))
  })
}

export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS }
  if (config && typeof config === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      const value = Number(config[key])
      if (Number.isFinite(value) && value > 0) settings[key] = Math.floor(value)
    }
  }

  const store = createStore(settings)

  const guarded = (handler) => (...args) => {
    try {
      handler(...args)
    } catch {
      // Recording must never disturb the run it observes.
    }
  }

  // One buffer per agent, filled while a turn runs and consumed when it settles:
  // enough to retire a coding turn even when the model forgets the retro call.
  const turns = new Map()
  // The buffer of the agent that ran most recently. A retrospective written over HTTP
  // arrives without an agent identity, so this is the turn it most plausibly belongs to.
  let recentBuffer = null

  function bufferOf(agent) {
    const id = agent && agent.id ? String(agent.id) : ''
    if (!id) return null
    let buffer = turns.get(id)
    if (!buffer) {
      buffer = { at: Date.now(), user: '', turn: 0, tools: [], files: [], errors: [], records: [], retro: false }
      turns.set(id, buffer)
    }
    recentBuffer = buffer
    return buffer
  }

  function pushUnique(list, value) {
    if (typeof value !== 'string' || !value) return
    if (list.length >= 12 || list.includes(value)) return
    list.push(value)
  }

  function noteFileArguments(args) {
    if (!args || typeof args !== 'object') return []
    const paths = []
    for (const key of ['file_path', 'filePath', 'path', 'target_file']) {
      const value = args[key]
      if (typeof value === 'string' && value) paths.push(value)
    }
    return paths
  }

  ctx.on(
    'agent/inbox/claimed',
    guarded((payload) => {
      if (!payload) return
      const buffer = bufferOf(payload.agent)
      if (!buffer) return
      const text = textOfMessage(payload.message)
      if (text) buffer.user = clip(text, 600)
      if (Number.isFinite(payload.turn)) buffer.turn = payload.turn
    }),
  )

  ctx.on(
    'agent/turn-stopping',
    guarded((payload) => {
      const agent = payload && payload.agent
      const id = agent && agent.id ? String(agent.id) : ''
      const buffer = id ? turns.get(id) : undefined
      if (!buffer) return
      turns.delete(id)
      if (buffer.retro) return
      // A retrospective written through the HTTP route or the CLI counts as the model's
      // own: never stack a skeleton on top of it.
      if (store.modelRetroSince(buffer.at)) return
      const coding = buffer.tools.some((name) => CODING_TOOLS.has(name))
      if (!coding) return
      // A skeleton is only worth a slot when the turn actually touched files or hit
      // an error: read-only expeditions are not coding tasks, and filler records
      // would otherwise crowd out the retrospectives the model wrote itself.
      if (buffer.files.length === 0 && buffer.errors.length === 0) return
      store.addRetro({
        auto: true,
        title: buffer.user ? clip(buffer.user, 100) : '编程任务 · 自动记录',
        done: '本轮工具：' + buffer.tools.join(' / '),
        cause: buffer.errors.length ? '本轮出现过错误，已另记在错误星图' : '',
        fix: '',
        lesson: '模型未提交复盘，由宿主自动留存骨架记录。',
        tags: ['auto'],
        tools: buffer.tools,
        files: buffer.files,
        errors: buffer.errors,
        errorIds: buffer.records,
        sessionId: id,
        turn: buffer.turn,
      })
    }),
  )

  ctx.on(
    'agent/error',
    guarded((payload) => {
      if (!payload) return
      const agent = payload.agent
      const sessionId = agent && agent.id ? String(agent.id) : undefined
      const entry = store.record({
        kind: 'agent',
        name: 'agent-step',
        message: payload.error,
        sessionId,
        turn: payload.turn,
        step: payload.step,
      })
      const buffer = bufferOf(agent)
      if (buffer && entry) pushUnique(buffer.records, entry.id)
    }),
  )

  ctx.on(
    'api-session/error',
    guarded((sessionId, message) => {
      const key = sessionId && String(sessionId)
      const entry = store.record({ kind: 'session', name: 'api-session', message, sessionId: key })
      const buffer = key ? turns.get(key) : undefined
      if (buffer && entry) pushUnique(buffer.records, entry.id)
    }),
  )

  ctx.on(
    'agent-loop/config-start-failed',
    guarded((payload) => {
      if (!payload) return
      const key = payload.sessionId && String(payload.sessionId)
      const entry = store.record({
        kind: 'config',
        name: 'config-start',
        message: payload.error,
        sessionId: key,
      })
      const buffer = key ? turns.get(key) : undefined
      if (buffer && entry) pushUnique(buffer.records, entry.id)
    }),
  )

  ctx.on(
    'tools/result',
    guarded((exec, result) => {
      if (!exec || !result) return
      const sessionId = exec.agent && exec.agent.id ? String(exec.agent.id) : undefined
      const buffer = bufferOf(exec.agent)
      if (buffer) {
        pushUnique(buffer.tools, exec.name)
        for (const path of noteFileArguments(exec.arguments)) pushUnique(buffer.files, path)
        if (result.isError === true) {
          const failure = result.error || {}
          const text = failure.message || failure
          if (buffer.errors.length < 6) buffer.errors.push(clip(String(text), 160))
        }
      }
      let entry
      if (result.isError === true) {
        const failure = result.error || {}
        entry = store.record({
          kind: 'tool',
          name: exec.name || 'tool',
          message: failure.message || failure,
          sessionId,
        })
      } else {
        const code = exitCodeOf(result)
        if (code === undefined) return
        const fingerprint = commandFingerprint(exec.arguments && exec.arguments.command)
        const detail = exitDetailOf(result)
        entry = store.record({
          kind: 'exit',
          name: exec.name || 'tool',
          message:
            'exit code ' +
            code +
            (fingerprint ? ' · ' + fingerprint : '') +
            (detail ? ' · ' + detail : ''),
          sessionId,
        })
      }
      if (buffer && entry) pushUnique(buffer.records, entry.id)
    }),
  )

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      scope.effect(
        () =>
          scope.webServer.register({
            name: 'error-atlas-data',
            kind: 'exact',
            path: '/error-atlas/data',
            handler: (req, res) => {
              if (!isLoopback(req)) {
                sendJson(res, 403, { error: 'loopback only' })
                return
              }
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                sendJson(res, 405, { error: 'method not allowed' })
                return
              }
              sendJson(res, 200, store.snapshot())
            },
          }),
        'error-atlas: data route',
      )
      scope.effect(
        () =>
          scope.webServer.register({
            name: 'error-atlas-clear',
            kind: 'exact',
            path: '/error-atlas/clear',
            handler: (req, res) => {
              if (!isLoopback(req)) {
                sendJson(res, 403, { error: 'loopback only' })
                return
              }
              if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'method not allowed' })
                return
              }
              store.clear()
              sendJson(res, 200, { ok: true, clearedAt: Date.now() })
            },
          }),
        'error-atlas: clear route',
      )
      scope.effect(
        () =>
          scope.webServer.register({
            name: 'error-atlas-export',
            kind: 'exact',
            path: '/error-atlas/export',
            handler: (req, res) => {
              if (!isLoopback(req)) {
                sendJson(res, 403, { error: 'loopback only' })
                return
              }
              if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'method not allowed' })
                return
              }
              try {
                const dir = join(homeRoot(), 'error-atlas', 'exports')
                mkdirSync(dir, { recursive: true })
                const snapshot = store.snapshot()
                const file = join(dir, 'atlas-' + fileStamp(Date.now()) + '.md')
                const text = formatAtlasMarkdown(snapshot)
                writeFileSync(file, text, 'utf8')
                sendJson(res, 200, {
                  ok: true,
                  path: file,
                  bytes: Buffer.byteLength(text, 'utf8'),
                  retros: snapshot.retros.length,
                })
              } catch (error) {
                sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
              }
            },
          }),
        'error-atlas: export route',
      )
      scope.effect(
        () =>
          scope.webServer.register({
            name: 'error-atlas-prefs',
            kind: 'exact',
            path: '/error-atlas/prefs',
            handler: async (req, res) => {
              if (!isLoopback(req)) {
                sendJson(res, 403, { ok: false, error: 'loopback only' })
                return
              }
              if (req.method === 'GET') {
                sendJson(res, 200, { ok: true, prefs: store.prefs() })
                return
              }
              if (req.method !== 'POST') {
                sendJson(res, 405, { ok: false, error: 'method not allowed' })
                return
              }
              const body = await readJsonBody(req)
              if (!body) {
                sendJson(res, 400, { ok: false, error: 'expected a JSON body' })
                return
              }
              try {
                const next = store.applyPrefs(body)
                sendJson(res, 200, { ok: true, prefs: next })
              } catch (error) {
                sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
              }
            },
          }),
        'error-atlas: prefs route',
      )
      scope.effect(
        () =>
          scope.webServer.register({
            name: 'error-atlas-retro',
            kind: 'exact',
            path: '/error-atlas/retro',
            handler: async (req, res) => {
              if (!isLoopback(req)) {
                sendJson(res, 403, { ok: false, error: 'loopback only' })
                return
              }
              if (req.method !== 'POST') {
                sendJson(res, 405, { ok: false, error: 'method not allowed' })
                return
              }
              const body = await readJsonBody(req)
              if (!body) {
                sendJson(res, 400, { ok: false, error: 'expected a JSON body' })
                return
              }
              const id = typeof body.id === 'string' ? body.id.trim() : ''
              const title = typeof body.title === 'string' ? body.title.trim() : ''
              const lesson = typeof body.lesson === 'string' ? body.lesson.trim() : ''
              if (!id && (!title || !lesson)) {
                sendJson(res, 400, { ok: false, error: 'a new retrospective needs title and lesson' })
                return
              }
              if (id && !store.hasRetro(id)) {
                sendJson(res, 404, { ok: false, error: 'no retrospective ' + id })
                return
              }
              try {
                // A CLI write carries prose, not telemetry. Fill the turn facts the
                // buffer already knows so an upgraded retrospective is not born blank.
                const fill = {}
                const buffer = recentBuffer
                if (buffer) {
                  if (!Array.isArray(body.tools) || body.tools.length === 0) fill.tools = buffer.tools.slice(0, 12)
                  if (!Array.isArray(body.files) || body.files.length === 0) fill.files = buffer.files.slice(0, 12)
                  if (!Array.isArray(body.errors) || body.errors.length === 0) fill.errors = buffer.errors.slice(0, 6)
                  if (!Array.isArray(body.errorIds) || body.errorIds.length === 0) fill.errorIds = buffer.records.slice(0, 12)
                  if (!Number.isFinite(body.turn) && buffer.turn) fill.turn = buffer.turn
                }
                const retro = store.upsertRetro({ ...fill, ...body, auto: false })
                sendJson(res, 200, { ok: true, id: retro.id, at: retro.at })
              } catch (error) {
                sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
              }
            },
          }),
        'error-atlas: retrospective route',
      )
      // The atlas-retro CLI needs this host's ephemeral port to post through the live
      // store; without it the CLI would edit the JSON file while the host owns it.
      try {
        const origin = typeof scope.webServer.getOrigin === 'function' ? String(scope.webServer.getOrigin()) : ''
        const url = new URL(origin)
        const dir = join(homeRoot(), 'error-atlas')
        mkdirSync(dir, { recursive: true })
        writeFileSync(
          join(dir, 'endpoint.json'),
          JSON.stringify({ origin: url.origin, port: Number(url.port) || 80, at: Date.now() }, null, 2),
          'utf8',
        )
      } catch {
        // No origin: the CLI falls back to the file with a warning.
      }
    })
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (scope) => {
      scope.effect(
        () =>
          scope.tools.register({
            name: 'atlas_retro',
            description:
              'Record the retrospective of the coding task you just finished: what was asked, what actually changed, the root cause, the fix, and the reusable lesson. Call it once per coding task, right before your final answer. The Harness stores these in the error atlas panel.',
            parameters: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'One line naming the task.' },
                done: { type: 'string', description: 'What actually changed, and in which files.' },
                cause: { type: 'string', description: 'Root cause of the failure or the decision that mattered.' },
                fix: { type: 'string', description: 'What solved it.' },
                lesson: { type: 'string', description: 'The reusable rule that prevents this next time.' },
                essence: {
                  type: 'string',
                  description:
                    'One line, at most ~70 characters: "<if this situation> -> <root cause class> -> <what to do next time>". This is the only line other sessions will see, so make it a rule, not a summary.',
                },
                tags: { type: 'array', items: { type: 'string' }, description: 'Short labels, e.g. render, plugin, build.' },
                errorIds: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Optional ids of the error nodes this task hit, to link the lesson to them; the Harness fills in this turn\u2019s errors automatically.',
                },
              },
              required: ['title', 'lesson'],
              additionalProperties: false,
            },
            output: {
              schema: {
                type: 'object',
                properties: { ok: { type: 'boolean' }, id: { type: 'string' }, at: { type: 'number' } },
                required: ['ok', 'id', 'at'],
                additionalProperties: false,
              },
              render(_args, value) {
                return [{ type: 'text', text: 'retrospective recorded as ' + value.id }]
              },
            },
            execute(args, exec) {
              const agent = exec && exec.agent
              const id = agent && agent.id ? String(agent.id) : undefined
              const buffer = id ? turns.get(id) : undefined
              const errorIds = []
              for (const recordId of buffer ? buffer.records : []) {
                if (errorIds.length < 12 && !errorIds.includes(recordId)) errorIds.push(recordId)
              }
              for (const recordId of Array.isArray(args.errorIds) ? args.errorIds : []) {
                if (typeof recordId !== 'string' || !recordId) continue
                if (errorIds.length < 12 && !errorIds.includes(recordId)) errorIds.push(recordId)
              }
              const retro = store.addRetro({
                auto: false,
                title: args.title,
                done: args.done,
                cause: args.cause,
                fix: args.fix,
                lesson: args.lesson,
                essence: args.essence,
                tags: args.tags,
                tools: buffer ? buffer.tools.slice(0, 12) : [],
                files: buffer ? buffer.files.slice(0, 12) : [],
                errors: buffer ? buffer.errors.slice(0, 6) : [],
                errorIds,
                sessionId: id,
                turn: buffer ? buffer.turn : undefined,
              })
              if (buffer) buffer.retro = true
              return Promise.resolve({ ok: true, id: retro.id, at: retro.at })
            },
          }),
        'error-atlas: retrospective tool',
      )

      // The read half: without it the atlas is a diary. This tool costs one schema
      // per step and pays off every time a coding task starts near a known trap.
      scope.effect(
        () =>
          scope.tools.register({
            name: 'atlas_lessons',
            description:
              'Read the lessons recorded by the error atlas: past coding retrospectives, their root cause, fix, and the reusable rule, each marked when the same error came back after it was written. Use it before starting a coding task in a familiar program, or when a failure looks like one you have seen before.',
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Optional free text matched against the title, lesson, cause, fix, tags, program and tool names.',
                },
                program: {
                  type: 'string',
                  description: 'Optional program hint, e.g. the folder name of a project; matched as a substring of the recorded program names.',
                },
                limit: { type: 'number', description: 'How many lessons to return, 1 to 20; defaults to 8.' },
              },
              additionalProperties: false,
            },
            output: {
              schema: {
                type: 'object',
                properties: {
                  total: { type: 'number' },
                  lessons: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        at: { type: 'number' },
                        auto: { type: 'boolean' },
                        title: { type: 'string' },
                        lesson: { type: 'string' },
                        cause: { type: 'string' },
                        fix: { type: 'string' },
                        tags: { type: 'array', items: { type: 'string' } },
                        programs: { type: 'array', items: { type: 'string' } },
                        tools: { type: 'array', items: { type: 'string' } },
                        stale: { type: 'number' },
                        staleAt: { type: 'number' },
                      },
                      required: ['id', 'at', 'title', 'lesson', 'stale'],
                      additionalProperties: false,
                    },
                  },
                },
                required: ['total', 'lessons'],
                additionalProperties: false,
              },
              render(_args, value) {
                if (value.total === 0) return [{ type: 'text', text: 'no lessons recorded yet' }]
                const lines = [value.total + ' lesson(s) · newest first, failed lessons on top']
                for (const item of value.lessons) {
                  const where = item.programs.length > 0 ? '[' + item.programs.join('/') + '] ' : ''
                  const flag = item.stale > 0 ? '⚠ ×' + item.stale + ' ' : ''
                  lines.push('- ' + flag + where + (item.lesson || item.title))
                }
                return [{ type: 'text', text: lines.join('\n') }]
              },
            },
            execute(args) {
              const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(20, Math.floor(args.limit))) : 8
              let lessons = store.lessonList(args.query)
              if (typeof args.program === 'string' && args.program.trim()) {
                const hint = args.program.trim().toLowerCase()
                lessons = lessons.filter((item) =>
                  item.programs.some((program) => program.toLowerCase().includes(hint)),
                )
              }
              const total = lessons.length
              return Promise.resolve({ total, lessons: lessons.slice(0, limit) })
            },
          }),
        'error-atlas: lesson tool',
      )
    })

    ctx.inject(['systemPrompt'], (scope) => {
      scope.effect(
        () =>
          scope.systemPrompt.section({
            name: 'error-atlas:retrospective',
            order: 300,
            text: () =>
              store.prefs().prompt === false
                ? ''
                : [
                    '## Task retrospectives',
                    'A coding turn (files written, a command run, a failure diagnosed) ends with one `atlas_retro` call before the final answer: `title`, `done` (what changed, where), `cause`, `fix`, `lesson`, and `essence` — one line shaped "<if this happens> -> <root cause> -> <what to do next time>", because that line is what other sessions get injected. Skip plain chat, reading and questions.',
                  ].join('\n'),
          }),
        'error-atlas: retrospective prompt section',
      )

      // Dynamic runtime context: the briefing is assembled per step from the current
      // store, and returns an empty string when nothing has been learned yet, so an
      // empty atlas costs nothing.
      scope.effect(
        () =>
          scope.systemPrompt.context({
            name: 'error-atlas:lessons',
            order: 400,
            text: () => store.lessonBriefing(6),
          }),
        'error-atlas: lesson prompt context',
      )
    })
  }
}
