window.__ModuleLoader__.load({
  id: 'dsh-error-atlas',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    // ─────────────────────────────────────────────────────────────────────────
    // constants
    // ─────────────────────────────────────────────────────────────────────────
    const PANEL_ID = 'error-atlas'
const NS = 'error-atlas'
    const DATA_PATH = '/error-atlas/data'
    const CLEAR_PATH = '/error-atlas/clear'
    const EXPORT_PATH = '/error-atlas/export'
    const PREFS_PATH = '/error-atlas/prefs'
    const POLL_MS = 6000
    const FOV = Math.PI / 3.3
    const CLOUD_RADIUS = 34
      // Program hubs orbit outside the error cloud, tethered to it by their links,
      // so a program reads as a satellite instead of another node in the ball.
      const SATELLITE_RADIUS = 46
      // Above this many nodes the exact O(n²) repulsion is replaced by a grid: the
      // pair count would otherwise freeze the panel while the atlas settles.
      const GRID_THRESHOLD = 400
      const REPULSION_CUTOFF = 30
    // Per-frame yaw at 100% on the slider. The slider spans a wide range on
    // purpose: the low end is a calm drift and the top end is unmistakably
    // spinning, so moving the control is visible without staring at it. One
    // revolution at full speed is about 35 seconds at 60fps.
    const SPIN_MAX = 0.003

    // Degrees per second at 100% (60fps), shown next to the slider so the value
    // has a visible meaning instead of being an abstract percent.
    const SPIN_DEG_PER_SEC = (SPIN_MAX * 60 * 180) / Math.PI

    // Light pulses that travel a lesson edge when an error starts being learned:
    // error node → retrospective node, like oil down a pipe. Each lesson edge gets
    // this many particles, and every particle loops with its own phase offset.
    const FLOW_PER_EDGE = 3
    const FLOW_MAX = 180
    const FLOW_SPEED = 0.0055
    const STYLE_ID = 'dsh-error-atlas-style'

    /**
     * The mistakes this plugin's own development produced, kept in the atlas on
     * purpose: a bug chart that cannot show its author's bugs is just decoration.
     * They live in the client half so a page refresh is enough to see them; the
     * host stays a pure runtime recorder. Times are local (Asia/Shanghai) and
     * mark when the defect was found.
     */
    const DEV_ERRORS = [
      { id: 'matrix-order', at: '2026-10-24T19:57:00+08:00', label: '矩阵乘法写反', message: 'view = Rx·Ry·T：先平移再绕原点旋转，整团云绕相机公转，越转越偏，最后飞出屏幕', tool: 'client.js · computeMatrices', fix: 'view = T·Ry·Rx（spin·view），节点在视空间里原地自转' },
      { id: 'powershell-utf8', at: '2026-10-24T20:07:00+08:00', label: 'PowerShell 管道毁中文', message: '用管道 + Set-Content 改 client.js，22 处中文字符串变成 GBK 乱码（鈥? 之类），面板里到处是问号', tool: 'pwsh · Set-Content', fix: '[IO.File]::ReadAllText / WriteAllText + UTF8Encoding($false)' },
      { id: 'bad-replacement', at: '2026-10-24T20:12:00+08:00', label: '修乱码时用 ? 兜底', message: '替换失败的字节被写成 0x3F，文件里混进一个裸 ?，差点当成正常文本发出去', tool: 'client.js', fix: '只写合法 UTF-8 文本，逐行校验后再次 node --check' },
      { id: 'framebuffer-order', at: '2026-10-24T20:03:00+08:00', label: '首帧全黑', message: '颜色附件绑定与清屏顺序错，第一版渲染器出来是纯黑画面，只能靠猜哪里没画上', tool: 'client.js · gl 状态', fix: '每帧先 clear，程序和 VAO 在首帧前建好，失败即回退' },
      { id: 'hole-seam', at: '2026-10-24T20:31:00+08:00', label: '黑洞核与盘之间露缝', message: '核画了透明渐变，0.94→1.02 之间透出面板底色，出现一圈灰绿环带；螺旋盘从 7.4 才开始，核到盘之间是空的', tool: 'client.js · drawBlackHole', fix: '去掉核的透明渐变，光环压在核边缘，盘从核半径处起' },
      { id: 'pause-partial', at: '2026-10-24T20:41:00+08:00', label: '暂停只停自转', message: '暂停只冻结 yaw，力导向模拟照常每帧推进，节点一直在动，看起来就像暂停没生效', tool: 'client.js · frame', fix: '暂停时跳过 simulate()，整个场景一起冻结' },
      { id: 'repulsion-boil', at: '2026-10-24T20:44:00+08:00', label: '斥力过大导致永不停歇', message: '95/d² 的斥力累积后速度顶到上限 1.6，整团云每秒漂几十个单位，所谓「自转」大半是它在沸腾', tool: 'client.js · simulate', fix: '沉降预算 140 帧后冻结位置，只保留刚性自转' },
      { id: 'slider-hitbox', at: '2026-10-24T20:20:00+08:00', label: '滑条摸不到', message: '轨道只有 2px、thumb 9px，鼠标很难压中；加上 20%~100% 只差 2 倍，看着就是坏的', tool: 'client.js · 自转滑条', fix: '命中区 16px、SPIN_MAX 提到 0.003、加 °/s 实时读数' },
      { id: 'per-frame-rotation', at: '2026-10-24T20:46:00+08:00', label: '自转按帧不按秒', message: 'yaw 每帧加固定量：60Hz 的屏上是对的，144Hz 上就快 2.4 倍，旁边的 °/s 读数也跟着骗人', tool: 'client.js · frame', fix: '用 dt 归一化（帧间隔 / 16.67ms），高刷屏与读数一致' },
      { id: 'ssr-stub-missing', at: '2026-10-24T20:15:00+08:00', label: 'SSR 桩缺 localStorage', message: '假 window 里没给 localStorage，组件初始化直接抛错，一度误判成 bundle 坏了', tool: '.ssr-check.cjs', fix: '桩里补齐 localStorage / matchMedia / ResizeObserver' },
      { id: 'bom-json', at: '2026-10-25T01:02:00+08:00', label: 'package.json 带 BOM', message: '写文件时混进 UTF-8 BOM，安装器的 JSON.parse 抛 Unexpected token 直接拒包；重启后既没有路由也没有面板，看起来像插件根本没装', tool: 'package.json', fix: 'JSON 一律无 BOM 写出（node 的 JSON.stringify 或 [IO.File]::WriteAllText + UTF8Encoding($false)）' },
      { id: 'inject-guard', at: '2026-10-25T01:52:00+08:00', label: '未 inject 就读服务', message: '面板里直接读 ctx.locale，Cordis 抛出 cannot get property "locale" without inject，整块面板被错误边界接住，只剩一行「渲染失败」', tool: 'client.js · apply', fix: '可选服务一律经 serviceOf() 读取并把异常吞成 null，绝不写进 inject' },
    ]

    // English copy of the author's own defects. Kept beside the Chinese list so the two
    // cannot drift apart silently; a missing id falls back to the Chinese entry.
    const DEV_EN = {
      'matrix-order': { label: 'Matrix multiply in the wrong order', message: 'view = Rx·Ry·T rotated the whole cloud around the camera: it drifted further every second and finally left the screen', fix: 'view = T·Ry·Rx (spin·view); nodes spin in place in view space' },
      'powershell-utf8': { label: 'PowerShell pipe mangled the Chinese text', message: 'Editing client.js through a pipe + Set-Content turned 22 Chinese strings into GBK mojibake, so the panel was full of question marks', fix: '[IO.File]::ReadAllText / WriteAllText + UTF8Encoding($false)' },
      'bad-replacement': { label: 'Repairing mojibake with a bare ?', message: 'Bytes that failed to replace were written as 0x3F, leaving a bare ? in the file that almost shipped as normal text', fix: 'only write valid UTF-8 and re-run node --check after each repair' },
      'framebuffer-order': { label: 'Black first frame', message: 'The colour attachment and the clear happened in the wrong order; the first renderer was pure black and the only debugging tool was guessing', fix: 'clear first every frame and build programs/VAOs before the first draw, else fall back' },
      'hole-seam': { label: 'Seam between the core and the disk', message: 'The core faded out between 0.94 and 1.02 so the panel background showed through as a grey-green ring, and the spiral only started at 7.4', fix: 'drop the core transparency, press the ring onto the core edge, start the disk at the core radius' },
      'pause-partial': { label: 'Pause only stopped the spin', message: 'Pause froze yaw but the force simulation kept stepping, so the cloud boiled and pause looked broken', fix: 'skip simulate() while paused; freeze the whole scene' },
      'repulsion-boil': { label: 'Repulsion kept the cloud boiling', message: '95/d² repulsion pushed velocities to the 1.6 cap, drifting dozens of units per second; most of the apparent spin was boiling', fix: 'settle for a fixed frame budget, then freeze positions and keep only rigid spin' },
      'slider-hitbox': { label: 'The slider was impossible to grab', message: 'A 2px track with a 9px thumb, and 20-100% only spanned 2x, so the control read as broken', fix: '16px hit area, SPIN_MAX raised to 0.003, live °/s readout' },
      'per-frame-rotation': { label: 'Spin counted frames, not seconds', message: 'yaw gained a fixed amount per frame: correct at 60Hz, 2.4x fast at 144Hz, and the °/s readout lied with it', fix: 'normalise with dt (frame interval / 16.67ms)' },
      'ssr-stub-missing': { label: 'SSR stub lacked localStorage', message: 'The fake window had no localStorage, so component init threw and the bundle got blamed', fix: 'add localStorage / matchMedia / ResizeObserver to the stub' },
      'bom-json': { label: 'package.json carried a BOM', message: 'A UTF-8 BOM slipped in, the installer JSON.parse rejected the package, and after a restart there were no routes and no panel, as if the plugin had never been installed', fix: 'always write JSON without a BOM (JSON.stringify or WriteAllText + UTF8Encoding($false))' },
      'inject-guard': { label: 'Reading a service without inject', message: 'The panel read ctx.locale directly; Cordis threw cannot get property "locale" without inject, the error boundary swallowed the whole panel and left one line of text behind', fix: 'read every optional service through serviceOf(), turn the throw into null, and never add it to inject' },
    }

    /** Merge the author's defects into whatever the host returned. */
    function withDev(payload) {
      const source = payload && typeof payload === 'object' ? payload : {}
      const nodes = Array.isArray(source.nodes) ? source.nodes.slice() : []
      const links = Array.isArray(source.links) ? source.links.slice() : []
      const have = new Set(nodes.map((node) => node.id))
      if (!have.has('root:dsh')) {
        nodes.unshift({ id: 'root:dsh', kind: 'root', label: 'DSH', count: (source.stats && source.stats.total) || 0 })
        have.add('root:dsh')
      }
      for (const dev of DEV_ERRORS) {
        const id = 'd:' + dev.id
        if (have.has(id)) continue
        // The author's own defects are data, not chrome, so they carry both languages
        // and resolve here; a missing translation falls back to the Chinese original.
        const copy = activeLocale === 'en' && DEV_EN[dev.id] ? Object.assign({}, dev, DEV_EN[dev.id]) : dev
        nodes.push({
          id,
          kind: 'dev',
          label: copy.label,
          message: copy.message,
          name: dev.tool,
          count: 1,
          fix: copy.fix,
          first: dev.at,
          last: dev.at,
        })
        links.push({ s: id, t: 'root:dsh' })
      }
      const stats = Object.assign({}, source.stats || {})
      // Retrospectives are recorded by the host as ready-made nodes; this loop
      // only covers an older host payload that predates them.
      const retros = Array.isArray(source.retros) ? source.retros : []
      for (const retro of retros) {
        if (!retro || typeof retro.title !== 'string') continue
        const id = 'rt:' + retro.id
        if (have.has(id)) continue
        nodes.push({
          id,
          kind: 'retro',
          label: retro.title,
          message: retro.done || retro.title,
          name: retro.auto ? 'AUTO RETRO' : 'RETRO',
          count: 1,
          first: retro.at,
          last: retro.at,
          retro,
        })
        links.push({ s: id, t: 'root:dsh' })
      }
      // Each lesson edge the host drew becomes a readable list on its node, so the
      // detail card can name the failures the retrospective came from.
      const byId = new Map(nodes.map((node) => [node.id, node]))
      for (const node of nodes) {
        if (node.kind !== 'retro') continue
        const linked = []
        for (const link of links) {
          if (!link || link.kind !== 'lesson' || link.s !== node.id) continue
          const target = byId.get(link.t)
          if (target) linked.push((target.name || 'ERR') + ' · ' + (target.message || ''))
        }
        if (linked.length) node.linked = linked
      }
      stats.dev = DEV_ERRORS.length
      stats.retro = retros.length
      stats.shown = nodes.length
      return Object.assign({}, source, { nodes, links, stats })
    }

    const KIND_TEXT = {
      agent: 'AGENT',
      session: 'SESSION',
      tool: 'TOOL',
      exit: 'EXIT',
      config: 'CONFIG',
      toolhub: 'TOOL',
      sessionhub: 'SESSION',
      root: 'DSH',
      dev: 'DEV',
      retro: 'RETRO',
      project: 'PROJECT',
    }

    const KIND_COLOR = {
      agent: [1.0, 0.27, 0.33],
      session: [1.0, 0.52, 0.62],
      tool: [1.0, 0.71, 0.44],
      exit: [1.0, 0.84, 0.56],
      config: [0.84, 0.62, 1.0],
      toolhub: [0.95, 0.95, 0.98],
      sessionhub: [1.0, 0.9, 0.94],
      root: [1.0, 0.97, 0.99],
      dev: [0.5, 0.95, 0.88],
      retro: [0.78, 0.62, 1.0],
      project: [0.5, 0.82, 1.0],
    }

    /** Hubs and the DSH core carry labels and a brighter halo. */
    function isHubNode(kind) {
      return kind === 'toolhub' || kind === 'sessionhub' || kind === 'project' || kind === 'root'
    }

    const KIND_CSS = {
      agent: '#ff4453',
      session: '#ff859d',
      tool: '#ffb570',
      exit: '#ffd68f',
      config: '#d89eff',
      dev: '#7ff3e0',
      retro: '#c7a4ff',
      project: '#7fd4ff',
      stale: '#ff5b4d',
    }

    // A lesson edge turns this colour — and its pulse runs backwards — when the error
    // it explains came back after the lesson was written.
    const STALE_COLOR = [1.0, 0.34, 0.3]

    // Bumped on every client change so the panel itself can prove which bundle is
    // live. The chip next to the title shows it; if it is stale the page is running
    // an older bundle and no amount of editing here will be visible.
    const BUILD = 'V50'

    const ZH = {
      nav: '错误星图',
      title: 'ERROR ATLAS',
      subtitle: '运行错误 · 任务复盘 · GPU 知识图谱',
      recording: 'REC',
      empty: 'NO ERRORS RECORDED',
      emptyHint: '暂无错误记录。',
      emptyDetail: '智能体步骤失败、API 会话错误、工具执行失败与非零退出码一旦发生，就会自动落进这张图。',
      loading: '正在读取记录…',
      failed: '无法读取错误记录',
      total: '累计错误',
      distinct: '去重条目',
      nodes: '图谱节点',
      sessions: '会话',
      tools: '工具',
      projects: '程序',
      dev: '开发错误',
      retro: '任务复盘',
      rTask: '任务',
      rDone: '做了什么',
      rCause: '根因',
      rFix: '解决',
      rLesson: '教训',
      rTools: '工具',
      rFiles: '文件',
      rErrors: '关联错误',
      rMode: '记录',
      rAuto: '宿主自动',
      rPicked: '模型复盘',
      stale: '教训失效',
      staleLesson: '这个错误在复盘之后又出现了',
      recurred: '复发',
      refresh: '刷新',
      relayout: '重排',
      exportMarkdown: '导出',
      exported: '已导出',
      exportFailed: '导出失败',
      spin: '自转',
      scale: '大小',
      halo: '光晕',
      flow: '光点',
      spread: '间距',
      nodeColors: '节点',
      linkColors: '线条',
      linkCore: '核心辐条',
      linkHub: '枢纽辐条',
      linkProject: '程序系绳',
      linkLesson: '教训线',
      style: '外观',
      pause: '暂停',
      resume: '继续',
      clear: '清空',
      clearConfirm: '清空全部运行时错误记录？此操作不可撤销。\n（青色的「开发错误」与紫色的「任务复盘」都是保留的，不会被清空）',
      recent: '最近错误',
      recentSub: 'RECENT EVENTS',
            hint: '拖拽旋转 · 滚轮缩放 · 点击节点以其为中心',
      focused: '已以「{name}」为中心',
      hintPaused: '已暂停 · 拖拽仍可环视 · 点「继续」恢复自转',
      count: '次数',
      lastSeen: '最近',
      firstSeen: '首次',
      session: '会话',
      turn: '轮次',
      step: '步骤',
      close: '关闭',
      errorTag: '错误',
      openSession: '打开会话',
      openSessionTip: '双击节点打开会话',
      minHits: '过滤',
      minHitsAll: '全部',
      muted: '已静音',
      truncated: '仅显示前',
      ignored: '已忽略',
      ignore: '忽略',
      ignoreConfirm: '把这条签名加入忽略规则？它的历史记录保留，但不再画进图谱。',
      ignoreEmpty: '没有可忽略的签名',
      ignoreFailed: '忽略规则保存失败',
      labels: '标题',
  labelsTip: '显示 / 隐藏星图上的标题',
  searchTitle: '搜索',
      searchHint: '错误 / 工具 / 程序 / 会话…',
      matched: '命中',
      noMatch: '无命中',
      activity: '活动',
      trendHour: '24 小时',
      trendDay: '30 天',
      trendNew: '新增签名',
      trendNote: '按最近事件统计 · 日志上限 400',
      trendCapped: '日志已达上限，柱状为下限',
      agoJust: '刚刚',
      agoMin: '{n} 分钟前',
      agoHour: '{n} 小时前',
      agoDay: '{n} 天前',
      truncatedHint: '{shown} 个节点 · 另有 {cut} 条被截断',
      mutedHint: '{n} 条已静音',
      webglTitle: 'WebGL 不可用',
      webglBody: '图谱渲染需要 WebGL；错误记录本身已正常工作。',
      collapse: '收起',
      expand: '展开',
      now: '现在',
      today: '今天',
      linkedCount: '{n} 条',
      recurredDetail: '{n} 次 · 最近 {time}',
      panelCrash: '图谱面板渲染失败',
      boardTitle: '教训有效性',
    memory: '记忆',
    memoryPrompt: '收尾提示',
    memoryInject: '注入教训',
    memoryTip: '关闭后不再写入提示词 / 不再注入教训，图谱与复盘照常记录',
      boardPrograms: '按程序',
      boardTags: '按标签',
      boardUnit: '条复盘',
      boardFailedShort: '失效',
      boardEmpty: '还没有可统计的复盘',
      boardHint: '点击某行按该标签筛选图谱',
    }

    // English copy. Anything missing falls back to the Chinese dictionary, so a partial
    // translation still renders instead of showing raw keys.
    const EN = {
      nav: 'Error Atlas',
      title: 'ERROR ATLAS',
      subtitle: 'runtime errors · retrospectives · GPU graph',
      recording: 'REC',
      empty: 'NO ERRORS RECORDED',
      emptyHint: 'No errors recorded yet.',
      emptyDetail: 'Agent step failures, API session errors, tool failures and non-zero exits land here automatically.',
      loading: 'Reading records…',
      failed: 'Could not read the error records',
      total: 'Total',
      distinct: 'Signatures',
      nodes: 'Nodes',
      sessions: 'Sessions',
      tools: 'Tools',
      projects: 'Programs',
      dev: 'Dev errors',
      retro: 'Retrospectives',
      rTask: 'Task',
      rDone: 'What changed',
      rCause: 'Cause',
      rFix: 'Fix',
      rLesson: 'Lesson',
      rTools: 'Tools',
      rFiles: 'Files',
      rErrors: 'Linked errors',
      rMode: 'Recorded by',
      rAuto: 'host skeleton',
      rPicked: 'model',
      stale: 'Failed lesson',
      staleLesson: 'This error returned after the retrospective',
      recurred: 'Recurred',
      refresh: 'Refresh',
      relayout: 'Relayout',
      exportMarkdown: 'Export',
      exported: 'Exported',
      exportFailed: 'Export failed',
      spin: 'Spin',
      scale: 'Size',
      halo: 'Glow',
      flow: 'Pulse',
      spread: 'Spread',
      nodeColors: 'Nodes',
      linkColors: 'Lines',
      linkCore: 'Core spokes',
      linkHub: 'Hub spokes',
      linkProject: 'Program tethers',
      linkLesson: 'Lesson wires',
      style: 'Look',
      pause: 'Pause',
      resume: 'Resume',
      clear: 'Clear',
      clearConfirm: 'Clear every runtime error record? This cannot be undone.\n(cyan dev errors and violet retrospectives are kept.)',
      recent: 'Recent errors',
      recentSub: 'RECENT EVENTS',
            hint: 'drag to rotate · wheel to zoom · click a node to orbit it',
      focused: 'orbiting “{name}”',
      hintPaused: 'Paused · you can still orbit · click Resume',
      count: 'Count',
      lastSeen: 'Last',
      firstSeen: 'First',
      session: 'Session',
      turn: 'Turn',
      step: 'Step',
      close: 'Close',
      errorTag: 'error',
      openSession: 'Open session',
      openSessionTip: 'double-click a node to open its session',
      minHits: 'Filter',
      minHitsAll: 'All',
      muted: 'muted',
      truncated: 'showing first',
      ignored: 'Ignored',
      ignore: 'Ignore',
      ignoreConfirm: 'Add this signature to the ignore rules? History stays, the node leaves the graph.',
      ignoreEmpty: 'Nothing to ignore',
      ignoreFailed: 'Could not save the ignore rule',
      labels: 'Labels',
  labelsTip: 'Show or hide the captions over the map',
  searchTitle: 'Search',
      searchHint: 'error / tool / program / session…',
      matched: 'matched',
      noMatch: 'no match',
      activity: 'Activity',
      trendHour: '24 hours',
      trendDay: '30 days',
      trendNew: 'new signatures',
      trendNote: 'counts recent events · log cap 400',
      trendCapped: 'log is capped, bars are a lower bound',
      agoJust: 'just now',
      agoMin: '{n} min ago',
      agoHour: '{n} h ago',
      agoDay: '{n} d ago',
      truncatedHint: '{shown} nodes · {cut} more truncated',
      mutedHint: '{n} muted',
      webglTitle: 'WebGL is unavailable',
      webglBody: 'The graph needs WebGL; the error records themselves still work.',
      collapse: 'collapse',
      expand: 'expand',
      now: 'now',
      today: 'today',
      linkedCount: '{n} linked',
      recurredDetail: '{n} times · last {time}',
      panelCrash: 'The graph panel failed to render',
      boardTitle: 'Lesson effectiveness',
    memory: 'Memory',
    memoryPrompt: 'Turn reminder',
    memoryInject: 'Injected lessons',
    memoryTip: 'Turned off: no prompt section and no injected lessons; the graph and retrospectives keep recording',
      boardPrograms: 'By program',
      boardTags: 'By tag',
      boardUnit: 'retros',
      boardFailedShort: 'failed',
      boardEmpty: 'Nothing to measure yet',
      boardHint: 'Click a row to filter the graph by that label',
    }

    // The panel was written against a single Chinese dictionary. Rather than thread a t()
    // through every call site, COPY resolves each read against the active locale, so the
    // whole surface follows the DSH language setting without touching the components.
    let activeLocale = 'zh'
    const DICTS = { zh: ZH, en: EN }
    const COPY = new Proxy(
      {},
      {
        get(_target, key) {
          const dict = DICTS[activeLocale] || ZH
          const value = dict[key]
          return value === undefined ? ZH[key] : value
        },
        has(_target, key) {
          return key in ZH
        },
      },
    )

    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined ? match : String(values[key])))
    }

    // ─────────────────────────────────────────────────────────────────────────
    // small utilities
    // ─────────────────────────────────────────────────────────────────────────
    function fmtNumber(value) {
      const n = Number(value) || 0
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
      if (n >= 10000) return (n / 1000).toFixed(1) + 'k'
      return String(n)
    }

    function clock(ts) {
      if (!ts) return '--:--:--'
      const d = new Date(ts)
      const p = (n) => String(n).padStart(2, '0')
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    }

    function relTime(ts) {
      if (!ts) return '—'
      const diff = Date.now() - ts
      if (diff < 60000) return COPY.agoJust
      if (diff < 3600000) return fill(COPY.agoMin, { n: Math.floor(diff / 60000) })
      if (diff < 86400000) return fill(COPY.agoHour, { n: Math.floor(diff / 3600000) })
      return fill(COPY.agoDay, { n: Math.floor(diff / 86400000) })
    }

    function truncate(text, max) {
      const s = String(text == null ? '' : text)
      return s.length > max ? s.slice(0, max - 1) + '…' : s
    }

    // ─────────────────────────────────────────────────────────────────────────
    // matrix helpers (column-major 4x4)
    // ─────────────────────────────────────────────────────────────────────────
    function identity(out) {
      out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0
      out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0
      out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0
      out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1
      return out
    }

    function multiply(out, a, b) {
      for (let c = 0; c < 4; c += 1) {
        const b0 = b[c * 4]
        const b1 = b[c * 4 + 1]
        const b2 = b[c * 4 + 2]
        const b3 = b[c * 4 + 3]
        out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3
        out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3
        out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3
        out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3
      }
      return out
    }

    function translation(out, x, y, z) {
      identity(out)
      out[12] = x
      out[13] = y
      out[14] = z
      return out
    }

    function rotationX(out, angle) {
      const c = Math.cos(angle)
      const s = Math.sin(angle)
      identity(out)
      out[5] = c
      out[6] = s
      out[9] = -s
      out[10] = c
      return out
    }

    function rotationY(out, angle) {
      const c = Math.cos(angle)
      const s = Math.sin(angle)
      identity(out)
      out[0] = c
      out[2] = -s
      out[8] = s
      out[10] = c
      return out
    }

    function perspective(out, fovy, aspect, near, far) {
      identity(out)
      const f = 1 / Math.tan(fovy / 2)
      out[0] = f / aspect
      out[5] = f
      out[10] = (far + near) / (near - far)
      out[11] = -1
      out[14] = (2 * far * near) / (near - far)
      out[15] = 0
      return out
    }

    // ─────────────────────────────────────────────────────────────────────────
    // shader sources
    // ─────────────────────────────────────────────────────────────────────────
    const NODE_VS = [
      'attribute vec3 aPosition;',
      'attribute vec3 aColor;',
      'attribute float aSize;',
      'attribute float aAlpha;',
      'uniform mat4 uVP;',
      'uniform float uFocal;',
      'uniform float uRefDist;',
      'uniform float uMaxSize;',
      'uniform float uSizeMul;',
      'uniform float uAlphaMul;',
      'varying vec3 vColor;',
      'varying float vAlpha;',
      'void main() {',
      '  vec4 clip = uVP * vec4(aPosition, 1.0);',
      '  gl_Position = clip;',
      '  float w = max(0.01, clip.w);',
      '  gl_PointSize = clamp(aSize * uSizeMul * uFocal / max(uRefDist, 1.0), 1.5, uMaxSize);',
      '  float fog = clamp(2.4 - w * 0.009, 0.08, 1.0);',
      '  vAlpha = aAlpha * uAlphaMul * fog;',
      '  vColor = aColor;',
      '}',
    ].join('\n')

    // A soft radial falloff, kept separate from the solid node core: this is the glow
    // that makes a dense atlas read as a nebula instead of a pile of dots.
    const HALO_FS = [
      'precision mediump float;',
      'varying vec3 vColor;',
      'varying float vAlpha;',
      'void main() {',
      '  vec2 p = gl_PointCoord - vec2(0.5);',
      '  float r = length(p) * 2.0;',
      '  if (r >= 1.0) discard;',
      '  float g = pow(1.0 - r, 2.1);',
      '  vec3 tint = mix(vColor, vec3(1.0), 0.25);',
      '  gl_FragColor = vec4(tint * g * 1.35, vAlpha * g);',
      '}',
    ].join('\n')

    const NODE_FS = [
      'precision mediump float;',
      'varying vec3 vColor;',
      'varying float vAlpha;',
      'void main() {',
      '  vec2 p = gl_PointCoord - vec2(0.5);',
      '  float r = length(p) * 2.0;',
      // The solid core only fills the middle of the sprite: a point-sized dot with a
      // crisp rim reads as a node, while a disc that fills the whole quad reads as a ball.
      '  float q = r * 1.75;',
      '  if (q >= 1.0) discard;',
      '  float edge = smoothstep(1.0, 0.86, q);',
      '  float lit = 0.6 + 0.4 * (1.0 - q * q);',
      '  float core = edge * lit;',
      '  float spark = pow(max(0.0, 1.0 - q * 2.0), 8.0) * 0.45;',
      '  gl_FragColor = vec4(vColor * (core + spark), vAlpha * edge * 0.9);',
      '}',
    ].join('\n')

    const LINK_VS = [
      'attribute vec3 aPosition;',
      'attribute vec3 aColor;',
      'attribute float aAlpha;',
      'uniform mat4 uVP;',
      'uniform float uAlphaMul;',
      'varying vec3 vColor;',
      'varying float vAlpha;',
      'void main() {',
      '  vec4 clip = uVP * vec4(aPosition, 1.0);',
      '  gl_Position = clip;',
      '  float w = max(0.01, clip.w);',
      '  vColor = aColor;',
      '  vAlpha = aAlpha * uAlphaMul * clamp(2.2 - w * 0.009, 0.04, 1.0);',
      '}',
    ].join('\n')

    const LINK_FS = [
      'precision mediump float;',
      'varying vec3 vColor;',
      'varying float vAlpha;',
      'void main() {',
      '  gl_FragColor = vec4(vColor, vAlpha);',
      '}',
    ].join('\n')

    function compileShader(gl, type, source) {
      const shader = gl.createShader(type)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader)
        gl.deleteShader(shader)
        throw new Error('shader compile failed: ' + info)
      }
      return shader
    }

    function createProgram(gl, vsSource, fsSource) {
      const program = gl.createProgram()
      const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource)
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource)
      gl.attachShader(program, vs)
      gl.attachShader(program, fs)
      gl.linkProgram(program)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const info = gl.getProgramInfoLog(program)
        gl.deleteProgram(program)
        throw new Error('program link failed: ' + info)
      }
      return program
    }

    // ─────────────────────────────────────────────────────────────────────────
    // renderer: force layout + WebGL draw + label/hit projection
    // ─────────────────────────────────────────────────────────────────────────
    function hashOf(id) {
      let hash = 2166136261
      for (let k = 0; k < id.length; k += 1) {
        hash = ((hash ^ id.charCodeAt(k)) * 16777619) >>> 0
      }
      return hash
    }

    // The stage grows with the atlas: 240 nodes keep the old 34 unit core, 2400 need
    // a wider one, otherwise the islands melt back into a single ball.
    function cloudRadiusFor(n) {
      return CLOUD_RADIUS * Math.max(1, Math.sqrt(Math.max(1, n) / 240))
    }

    /** Orbit radius for the program satellites: close enough to read as part of the map. */
    function satelliteRadiusFor(cloud) {
      return Math.max(SATELLITE_RADIUS, cloud * 1.45)
    }

    /** Deterministic orbit slot for a hub, so a refresh never reshuffles the map. */
    function hubSlot(node, islandRadius, satRadius) {
      const hash = hashOf(node.id)
      if (node.kind === 'sessionhub') {
        const angle = ((hash % 997) / 997) * Math.PI * 2
        const tilt = (((hash >>> 10) % 991) / 991) * 0.9 - 0.45
        const ring = islandRadius * (0.92 + ((hash >>> 20) % 100) / 420)
        return [
          Math.cos(angle) * Math.cos(tilt) * ring,
          Math.sin(tilt) * ring,
          Math.sin(angle) * Math.cos(tilt) * ring,
        ]
      }
      if (node.kind === 'toolhub') {
        const angle = ((hash % 991) / 991) * Math.PI * 2
        const ring = islandRadius * 0.34
        return [
          Math.cos(angle) * ring,
          (((hash >>> 8) % 100) / 100 - 0.5) * ring * 0.5,
          Math.sin(angle) * ring,
        ]
      }
      if (node.kind === 'project') {
        const angle = ((hash % 997) / 997) * Math.PI * 2
        const tilt = (((hash >>> 10) % 991) / 991) * 1.15 - 0.575
        const ring = satRadius * (0.9 + ((hash >>> 20) % 100) / 500)
        return [
          Math.cos(angle) * Math.cos(tilt) * ring,
          Math.sin(tilt) * ring,
          Math.sin(angle) * Math.cos(tilt) * ring,
        ]
      }
      return [0, 0, 0]
    }


    function createRenderer(canvas, labelHost, handlers) {
      const gl =
        canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false, powerPreference: 'high-performance' }) ||
        canvas.getContext('experimental-webgl', { antialias: true, alpha: true })

      if (!gl) return null

      const nodeProgram = createProgram(gl, NODE_VS, NODE_FS)
      const haloProgram = typeof HALO_FS === 'string' ? createProgram(gl, NODE_VS, HALO_FS) : null
      const linkProgram = createProgram(gl, LINK_VS, LINK_FS)

      const nodeLoc = {
        position: gl.getAttribLocation(nodeProgram, 'aPosition'),
        color: gl.getAttribLocation(nodeProgram, 'aColor'),
        size: gl.getAttribLocation(nodeProgram, 'aSize'),
        alpha: gl.getAttribLocation(nodeProgram, 'aAlpha'),
        uVP: gl.getUniformLocation(nodeProgram, 'uVP'),
        uFocal: gl.getUniformLocation(nodeProgram, 'uFocal'),
        uRefDist: gl.getUniformLocation(nodeProgram, 'uRefDist'),
        uMaxSize: gl.getUniformLocation(nodeProgram, 'uMaxSize'),
        uSizeMul: gl.getUniformLocation(nodeProgram, 'uSizeMul'),
        uAlphaMul: gl.getUniformLocation(nodeProgram, 'uAlphaMul'),
      }
      const haloLoc = {
        position: gl.getAttribLocation(haloProgram, 'aPosition'),
        color: gl.getAttribLocation(haloProgram, 'aColor'),
        size: gl.getAttribLocation(haloProgram, 'aSize'),
        alpha: gl.getAttribLocation(haloProgram, 'aAlpha'),
        uVP: gl.getUniformLocation(haloProgram, 'uVP'),
        uFocal: gl.getUniformLocation(haloProgram, 'uFocal'),
        uRefDist: gl.getUniformLocation(haloProgram, 'uRefDist'),
        uMaxSize: gl.getUniformLocation(haloProgram, 'uMaxSize'),
        uSizeMul: gl.getUniformLocation(haloProgram, 'uSizeMul'),
        uAlphaMul: gl.getUniformLocation(haloProgram, 'uAlphaMul'),
      }
      const linkLoc = {
        position: gl.getAttribLocation(linkProgram, 'aPosition'),
        color: gl.getAttribLocation(linkProgram, 'aColor'),
        alpha: gl.getAttribLocation(linkProgram, 'aAlpha'),
        uVP: gl.getUniformLocation(linkProgram, 'uVP'),
        uAlphaMul: gl.getUniformLocation(linkProgram, 'uAlphaMul'),
      }

      const nodeBuffers = {
        position: gl.createBuffer(),
        color: gl.createBuffer(),
        size: gl.createBuffer(),
        alpha: gl.createBuffer(),
      }
      const linkBuffers = {
        position: gl.createBuffer(),
        color: gl.createBuffer(),
        alpha: gl.createBuffer(),
      }
      const flowBuffers = {
        position: gl.createBuffer(),
        color: gl.createBuffer(),
        size: gl.createBuffer(),
        alpha: gl.createBuffer(),
      }

      const state = {
        nodes: [],
        byId: new Map(),
        links: [],
        count: 0,
        pos: new Float32Array(0),
        anchor: new Float32Array(0),
        islandHub: new Int32Array(0),
        degree: new Int32Array(0),
        anchored: new Uint8Array(0),
        cloudRadius: CLOUD_RADIUS,
        vel: new Float32Array(0),
        mass: new Float32Array(0),
        color: new Float32Array(0),
        size: new Float32Array(0),
        alpha: new Float32Array(0),
        baseAlpha: new Float32Array(0),
        pairs: new Int32Array(0),
        linkVerts: new Float32Array(0),
        linkColor: new Float32Array(0),
        linkAlpha: new Float32Array(0),
        // Lesson pipelines: light pulses running error → retrospective.
        lessonEdges: [],
        flowCount: 0,
        flowEdge: new Int32Array(FLOW_MAX),
        flowPhase: new Float32Array(FLOW_MAX),
        flowPos: new Float32Array(FLOW_MAX * 3),
        flowColor: new Float32Array(FLOW_MAX * 3),
        flowSize: new Float32Array(FLOW_MAX),
        flowAlpha: new Float32Array(FLOW_MAX),
        learnBoost: 0,
        learnRetros: new Set(),
        knownRetros: new Set(),
        yaw: 0.55,
        pitch: -0.14,
        dist: 96,
        targetDist: 96,
        scale: 1,
        halo: 1,
        flowScale: 1,
        // How far apart the nodes sit. Positions only: node and pulse diameters keep
        // their own dials, so the wire lengths can breathe without resizing anything.
        spread: 1,
        focus: new Float32Array(3),
        focusTarget: new Float32Array(3),
        selected: null,
        hovered: null,
        neighbors: new Set(),
        warmup: 0,
        simBudget: 0,
        lastFrame: 0,
        focalCss: 400,
        spin: 0.2,
        paused: false,
        dpr: 1,
        sx: new Float32Array(0),
        sy: new Float32Array(0),
        depth: new Float32Array(0),
        radii: new Float32Array(0),
        labelNodes: [],
        labels: new Map(),
        dragging: false,
        moved: 0,
        lastX: 0,
        lastY: 0,
        raf: 0,
        disposed: false,
        alphaDirty: true,
        // Colour filters: node kinds and link roles the user has switched off.
        hiddenKinds: new Set(),
        hiddenLinks: new Set(),
        linkRoles: [],
        signature: null,
        needsFit: true,
        fitDist: 96,
        clock: 0,
        // Search is a client-side lens over the snapshot: matching nodes keep their
        // light, everything else fades so the shape of an answer is visible at once.
        matches: null,
        // The captions floating over the cloud can be switched off; the dust keeps its glow.
        showLabels: true,
      }

      function ensureLabels(list) {
        const keep = new Set()
        for (const node of list) {
          keep.add(node.id)
          let el = state.labels.get(node.id)
          if (!el) {
            el = document.createElement('div')
            el.className = 'dshea-label' + (isHubNode(node.kind) ? ' is-hub' : '')
            if (node.kind === 'retro' && node.recurred > 0) el.classList.add('is-stale')
            el.textContent = isHubNode(node.kind)
              ? node.label
              : truncate(node.kind === 'retro' ? node.label : node.message || node.label, 30) +
                (node.kind === 'retro' && node.recurred > 0 ? ' ⚠' : '')
            labelHost.appendChild(el)
            state.labels.set(node.id, el)
          }
        }
        for (const [id, el] of state.labels) {
          if (keep.has(id)) continue
          if (el.parentNode) el.parentNode.removeChild(el)
          state.labels.delete(id)
        }
        state.labelNodes = list
      }

      function initLayout(previous) {
        const n = state.count
        const pos = state.pos
        const mass = state.mass
        const size = state.size
        const nodes = state.nodes
        let seed = 1337
        const rand = () => {
          seed = (seed * 1664525 + 1013904223) >>> 0
          return seed / 4294967296
        }

        const cloud = cloudRadiusFor(n)
        const satRadius = satelliteRadiusFor(cloud)
        // Each window needs room: 34 units of arc per island, capped so the satellites
        // always stay outside the ring.
        let sessionCount = 0
        for (let i = 0; i < n; i += 1) if (nodes[i].kind === 'sessionhub') sessionCount += 1
        const islandRadius = Math.min(satRadius * 0.9, Math.max(cloud * 0.74, (sessionCount * 34) / (Math.PI * 2)))
        state.cloudRadius = cloud
        state.anchor = new Float32Array(n * 3)
        state.anchored = new Uint8Array(n)

        const degree = new Int32Array(n)
        for (let k = 0; k < state.pairs.length; k += 2) {
          degree[state.pairs[k]] += 1
          degree[state.pairs[k + 1]] += 1
        }
        state.degree = degree

        const islandHub = new Int32Array(n).fill(-1)
        state.islandHub = islandHub
        const hubIndex = new Map()
        for (let i = 0; i < n; i += 1) if (nodes[i].kind === 'sessionhub') hubIndex.set(nodes[i].id, i)

        const hubAnchors = new Map()
        for (let i = 0; i < n; i += 1) {
          const node = nodes[i]
          if (isHubNode(node.kind) && node.kind !== 'project') hubAnchors.set(node.id, hubSlot(node, islandRadius, satRadius))
        }

        // A failure belongs to the session window it happened in. That island anchor is
        // weak on purpose: the hub springs still decide the shape, the anchor only keeps
        // one island from bleeding into the next one.
        const islandOf = new Map()
        for (const link of state.links) {
          const a = nodes[link.a]
          const b = nodes[link.b]
          if (!a || !b) continue
          if (a.kind === 'sessionhub' && !isHubNode(b.kind) && !islandOf.has(b.id)) islandOf.set(b.id, a.id)
          else if (b.kind === 'sessionhub' && !isHubNode(a.kind) && !islandOf.has(a.id)) islandOf.set(a.id, b.id)
        }

        // A retrospective has no direct window link: it borrows the island of the failures it
        // wrote a lesson about, so the learning stays next to the mistakes it came from.
        for (const link of state.links) {
          const a = nodes[link.a]
          const b = nodes[link.b]
          if (!a || !b) continue
          if (islandOf.has(a.id) && !islandOf.has(b.id) && !isHubNode(b.kind)) islandOf.set(b.id, islandOf.get(a.id))
          else if (islandOf.has(b.id) && !islandOf.has(a.id) && !isHubNode(a.kind)) islandOf.set(a.id, islandOf.get(b.id))
        }


        // A program satellite is placed on the side of the map where its own failures are:
        // average the islands of the errors it is linked to and park it on that heading.
        // A hash angle put a program next to the cluster on one refresh and opposite it on
        // the next, which is why "docs" and "dsh-error-atlas" looked stranded.
        const projectPull = new Map()
        for (const link of state.links) {
          const a = nodes[link.a]
          const b = nodes[link.b]
          if (!a || !b) continue
          const project = a.kind === 'project' ? a : b.kind === 'project' ? b : null
          if (!project) continue
          const other = project === a ? b : a
          if (isHubNode(other.kind)) continue
          const island = islandOf.get(other.id)
          const base = island ? hubAnchors.get(island) : null
          if (!base) continue
          const acc = projectPull.get(project.id) || [0, 0, 0]
          acc[0] += base[0]
          acc[1] += base[1]
          acc[2] += base[2]
          projectPull.set(project.id, acc)
        }
        // Programs whose failures share one window would all land on the same heading, so
        // their headings are fanned out around that direction instead of stacking.
        const wanted = []
        for (const [id, acc] of projectPull) {
          const horizontal = Math.hypot(acc[0], acc[2])
          if (horizontal < 1e-3) continue
          wanted.push({ id, angle: Math.atan2(acc[2], acc[0]), y: acc[1] })
        }
        wanted.sort((left, right) => left.angle - right.angle)
        const taken = []
        const angularGap = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))
        for (const item of wanted) {
          let angle = item.angle
          let step = 1
          while (taken.some((other) => angularGap(other, angle) < 0.36)) {
            const swing = Math.ceil(step / 2) * 0.42
            angle = item.angle + (step % 2 === 1 ? swing : -swing)
            step += 1
          }
          taken.push(angle)
          const ring = satRadius * (0.94 + (hashOf(item.id) % 60) / 600)
          hubAnchors.set(item.id, [Math.cos(angle) * ring, item.y * 0.06, Math.sin(angle) * ring])
        }

        // A program with no linked failure yet still gets its place on the ring, so it never
        // collapses into the cloud just because it has nothing to point at.
        for (let i = 0; i < n; i += 1) {
          const node = nodes[i]
          if (node.kind === 'project' && !hubAnchors.has(node.id)) hubAnchors.set(node.id, hubSlot(node, islandRadius, satRadius))
        }

        // Anchors inside one island are spread with a golden-angle spiral, so the island is
        // a volume and not a ring of equidistant failures.
        const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
        const islandLeaves = new Map()
        for (const islandId of islandOf.values()) islandLeaves.set(islandId, (islandLeaves.get(islandId) || 0) + 1)
        const islandSeen = new Map()
        state.islandMode = islandOf.size > 0

        for (let i = 0; i < n; i += 1) {
          const node = nodes[i]
          const isRoot = node.kind === 'root'
          const isHub = isHubNode(node.kind)
          mass[i] = isRoot ? 60 : isHub ? 9 : 1
          size[i] = isRoot
            ? 11
            : isHub
              ? 4.2 + Math.min(4.6, Math.sqrt(node.count || 1) * 1.15)
              : 1.5 + Math.min(2.6, Math.sqrt(node.count || 1) * 0.82)
          if (isRoot) {
            pos[i * 3] = 0
            pos[i * 3 + 1] = 0
            pos[i * 3 + 2] = 0
            state.anchored[i] = 1
            continue
          }
          if (hubAnchors.has(node.id)) {
            const [ax, ay, az] = hubAnchors.get(node.id)
            state.anchor[i * 3] = ax
            state.anchor[i * 3 + 1] = ay
            state.anchor[i * 3 + 2] = az
            state.anchored[i] = 1
          } else {
            const island = islandOf.get(node.id)
            const base = island ? hubAnchors.get(island) : null
            if (base) {
              // Spread a window's failures through the volume of its own island instead of
              // stacking every anchor on one point: a single point turns the island into a
              // repulsion bomb and the failures end up pinned to the clamp shell.
              const total = islandLeaves.get(island) || 1
              const seen = islandSeen.get(island) || 0
              islandSeen.set(island, seen + 1)
              const u = (seen + 0.5) / total
              const radius = cloud * 0.30 * Math.cbrt(u)
              const phi = Math.acos(1 - 2 * u)
              const theta = GOLDEN_ANGLE * seen
              state.anchor[i * 3] = base[0] + radius * Math.sin(phi) * Math.cos(theta)
              state.anchor[i * 3 + 1] = base[1] + radius * Math.cos(phi)
              state.anchor[i * 3 + 2] = base[2] + radius * Math.sin(phi) * Math.sin(theta)
            } else {
              const radius = cloud * 0.4 * Math.cbrt(rand())
              const phi = Math.acos(1 - 2 * rand())
              const theta = 2 * Math.PI * rand()
              state.anchor[i * 3] = radius * Math.sin(phi) * Math.cos(theta)
              state.anchor[i * 3 + 1] = radius * Math.cos(phi)
              state.anchor[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta)
            }
            const owner = island ? hubIndex.get(island) : undefined
            if (owner !== undefined) islandHub[i] = owner
          }
          const kept = previous && previous.get(node.id)
          if (kept && state.anchored[i] === 0) {
            pos[i * 3] = kept[0]
            pos[i * 3 + 1] = kept[1]
            pos[i * 3 + 2] = kept[2]
            continue
          }
          if (state.anchored[i]) {
            pos[i * 3] = state.anchor[i * 3]
            pos[i * 3 + 1] = state.anchor[i * 3 + 1]
            pos[i * 3 + 2] = state.anchor[i * 3 + 2]
            continue
          }
          const radius = cloud * (0.25 + rand() * 0.55)
          const theta = rand() * Math.PI * 2
          const phi = Math.acos(2 * rand() - 1)
          pos[i * 3] = radius * Math.sin(phi) * Math.cos(theta)
          pos[i * 3 + 1] = radius * Math.cos(phi) * 0.72
          pos[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta)
        }
        state.vel.fill(0)
        // Big atlases settle with fewer, shorter passes: the layout has to be usable at
        // 2400 nodes, and a 210 frame warm-up there would stall the first paint for seconds.
        const warm = Math.max(40, Math.min(210, Math.round(90000 / Math.max(1, n))))
        state.warmup = previous ? Math.min(60, warm) : warm
        state.simBudget = previous ? 60 : Math.max(24, Math.min(70, Math.round(48000 / Math.max(1, n))))
      }

      function simulate() {
        const n = state.count
        if (n === 0) return
        const pos = state.pos
        const vel = state.vel
        const mass = state.mass
        const nodes = state.nodes
        // With islands the anchors decide the shape, so repulsion only has to stop nodes
        // from overlapping; 95 was calibrated for one sparse cloud and pins dense islands
        // to their clamp shell. Without sessions keep the old value.
        const repulsion = state.islandMode ? 30 : 95

        if (n > GRID_THRESHOLD) {
          // Uniform grid: only nearby pairs repel. The far field is covered by the island
          // anchors, so truncating the 1/d² tail does not collapse the layout.
          const cell = REPULSION_CUTOFF
          const buckets = new Map()
          for (let i = 0; i < n; i += 1) {
            const ix = i * 3
            const key =
              Math.floor(pos[ix] / cell) + ',' + Math.floor(pos[ix + 1] / cell) + ',' + Math.floor(pos[ix + 2] / cell)
            const list = buckets.get(key)
            if (list) list.push(i)
            else buckets.set(key, [i])
          }
          for (let i = 0; i < n; i += 1) {
            const ix = i * 3
            const px = pos[ix]
            const py = pos[ix + 1]
            const pz = pos[ix + 2]
            const bx = Math.floor(px / cell)
            const by = Math.floor(py / cell)
            const bz = Math.floor(pz / cell)
            let fx = 0
            let fy = 0
            let fz = 0
            for (let ox = -1; ox <= 1; ox += 1) {
              for (let oy = -1; oy <= 1; oy += 1) {
                for (let oz = -1; oz <= 1; oz += 1) {
                  const list = buckets.get(bx + ox + ',' + (by + oy) + ',' + (bz + oz))
                  if (!list) continue
                  for (let m = 0; m < list.length; m += 1) {
                    const j = list[m]
                    if (j <= i) continue
                    const jx = j * 3
                    let dx = px - pos[jx]
                    let dy = py - pos[jx + 1]
                    let dz = pz - pos[jx + 2]
                    let d2 = dx * dx + dy * dy + dz * dz
                    if (d2 > REPULSION_CUTOFF * REPULSION_CUTOFF) continue
                    if (d2 < 0.02) {
                      d2 = 0.02
                      dx += 0.01
                      dy += 0.01
                      dz += 0.01
                    }
                    // Two failures of the same window share one island and are expected to
                    // sit close: full repulsion would push the whole island onto its clamp
                    // shell. Strangers keep the full push, which is what separates islands.
                    const soft = state.islandHub[i] >= 0 && state.islandHub[i] === state.islandHub[j] ? 0.3 : 1
                    const inv = (repulsion * soft) / (d2 * Math.sqrt(d2))
                    fx += dx * inv
                    fy += dy * inv
                    fz += dz * inv
                  }
                }
              }
            }
            vel[ix] += fx / mass[i]
            vel[ix + 1] += fy / mass[i]
            vel[ix + 2] += fz / mass[i]
          }
        } else {
          for (let i = 0; i < n; i += 1) {
            const ix = i * 3
            const px = pos[ix]
            const py = pos[ix + 1]
            const pz = pos[ix + 2]
            let fx = 0
            let fy = 0
            let fz = 0
            for (let j = i + 1; j < n; j += 1) {
              const jx = j * 3
              let dx = px - pos[jx]
              let dy = py - pos[jx + 1]
              let dz = pz - pos[jx + 2]
              let d2 = dx * dx + dy * dy + dz * dz
              if (d2 < 0.02) {
                d2 = 0.02
                dx += 0.01
                dy += 0.01
                dz += 0.01
              }
              // As in the grid path: siblings inside one island tolerate each other.
              const soft = state.islandHub[i] >= 0 && state.islandHub[i] === state.islandHub[j] ? 0.3 : 1
              const inv = (repulsion * soft) / (d2 * Math.sqrt(d2))
              fx += dx * inv
              fy += dy * inv
              fz += dz * inv
            }
            vel[ix] += fx / mass[i]
            vel[ix + 1] += fy / mass[i]
            vel[ix + 2] += fz / mass[i]
          }
        }

        const pairs = state.pairs
        const linkCount = pairs.length / 2
        for (let k = 0; k < linkCount; k += 1) {
          const i = pairs[k * 2]
          const j = pairs[k * 2 + 1]
          const ix = i * 3
          const jx = j * 3
          const dx = pos[jx] - pos[ix]
          const dy = pos[jx + 1] - pos[ix + 1]
          const dz = pos[jx + 2] - pos[ix + 2]
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01
          // Not every edge means the same thing: a failure is pulled tight to its window,
          // loosely to its tool, and only tethered to the core.
          const ka = nodes[i].kind
          const kb = nodes[j].kind
          let target = 12
          let stiffness = 0.02
          if (state.links[k] && state.links[k].lesson) {
            target = 18
            stiffness = 0.02
          } else if (ka === 'sessionhub' || kb === 'sessionhub') {
            target = 10
            stiffness = 0.07
          } else if (ka === 'project' || kb === 'project') {
            target = 13
            stiffness = 0.03
          } else if (ka === 'root' || kb === 'root') {
            target = 14
            stiffness = 0.004
          }
          // A hub with hundreds of links must not be dragged inward by all of them at
          // once, or the program satellites sink into the error cloud.
          // Only satellites need the degree damping: a window hub is the spine of its island,
          // and weakening those links lets the island flatten onto its clamp shell.
          if (ka === 'project' || kb === 'project') {
            const hubDegree = Math.max(state.degree[i] || 0, state.degree[j] || 0)
            if (hubDegree > 12) stiffness *= 12 / hubDegree
          }
          const force = (d - target) * stiffness
          const ux = (dx / d) * force
          const uy = (dy / d) * force
          const uz = (dz / d) * force
          vel[ix] += ux / mass[i]
          vel[ix + 1] += uy / mass[i]
          vel[ix + 2] += uz / mass[i]
          vel[jx] -= ux / mass[j]
          vel[jx + 1] -= uy / mass[j]
          vel[jx + 2] -= uz / mass[j]
        }

        // Island anchors: hubs are pinned on their slot, failures are held loosely so the
        // hub springs still decide the local shape.
        for (let i = 0; i < n; i += 1) {
          const ix = i * 3
          const k = state.anchored[i] ? 0.16 : 0.8
          vel[ix] += (state.anchor[ix] - pos[ix]) * k
          vel[ix + 1] += (state.anchor[ix + 1] - pos[ix + 1]) * k
          vel[ix + 2] += (state.anchor[ix + 2] - pos[ix + 2]) * k
        }

        for (let i = 0; i < n; i += 1) {
          const ix = i * 3
          let vx = (vel[ix] - pos[ix] * 0.0016) * 0.8
          let vy = (vel[ix + 1] - pos[ix + 1] * 0.0016) * 0.8
          let vz = (vel[ix + 2] - pos[ix + 2] * 0.0016) * 0.8
          let speed = Math.sqrt(vx * vx + vy * vy + vz * vz)
          if (speed > 1.6) {
            const scale = 1.6 / speed
            vx *= scale
            vy *= scale
            vz *= scale
            speed = 1.6
          }
          // Settle: below this the cloud must stop dead, otherwise the leftover
          // repulsion keeps it boiling and "pause" looks broken.
          if (speed < 0.03) {
            vx = 0
            vy = 0
            vz = 0
          }
          vel[ix] = vx
          vel[ix + 1] = vy
          vel[ix + 2] = vz
          pos[ix] += vx * 0.9
          pos[ix + 1] += vy * 0.9
          pos[ix + 2] += vz * 0.9
        }

        // Keep the cloud anchored and clamp it inside a bounded sphere every frame.
        // Without this the repulsion drifts the whole cloud past the camera and the
        // graph silently leaves the screen. When a DSH core node exists it *is* the
        // anchor, so the cloud is never recentred away from it.
        const hasRoot = nodes.some((node) => node.kind === 'root')
        let cx = 0
        let cy = 0
        let cz = 0
        if (!hasRoot) {
          for (let i = 0; i < n; i += 1) {
            cx += pos[i * 3]
            cy += pos[i * 3 + 1]
            cz += pos[i * 3 + 2]
          }
          cx /= n
          cy /= n
          cz /= n
        }
        const cloud = state.cloudRadius || CLOUD_RADIUS
        for (let i = 0; i < n; i += 1) {
          const ix = i * 3
          const kind = nodes[i].kind
          if (kind === 'root') {
            pos[ix] = 0
            pos[ix + 1] = 0
            pos[ix + 2] = 0
            vel[ix] = 0
            vel[ix + 1] = 0
            vel[ix + 2] = 0
            continue
          }
          let px = pos[ix] - cx
          let py = pos[ix + 1] - cy
          let pz = pos[ix + 2] - cz
          const r = Math.sqrt(px * px + py * py + pz * pz)
          const limit = kind === 'project' ? satelliteRadiusFor(cloud) * 1.3 : isHubNode(kind) ? cloud * 1.35 : cloud * 1.12
          if (r > limit) {
            const s = limit / r
            px *= s
            py *= s
            pz *= s
            vel[ix] *= 0.35
            vel[ix + 1] *= 0.35
            vel[ix + 2] *= 0.35
          }
          pos[ix] = px
          pos[ix + 1] = py
          pos[ix + 2] = pz

          const owner = state.islandHub[i]
          if (owner >= 0 && owner !== i) {
            const ox = owner * 3
            let dx = pos[ix] - pos[ox]
            let dy = pos[ix + 1] - pos[ox + 1]
            let dz = pos[ix + 2] - pos[ox + 2]
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
            const reach = cloud * 0.42
            if (d > reach) {
              const s = reach / d
              pos[ix] = pos[ox] + dx * s
              pos[ix + 1] = pos[ox + 1] + dy * s
              pos[ix + 2] = pos[ox + 2] + dz * s
              vel[ix] *= 0.4
              vel[ix + 1] *= 0.4
              vel[ix + 2] *= 0.4
            }
          }
        }
      }

      /** Frame the whole cloud, so nothing starts outside the viewport. */
      function scaling(out, k) {
        out[0] = k
        out[1] = 0
        out[2] = 0
        out[3] = 0
        out[4] = 0
        out[5] = k
        out[6] = 0
        out[7] = 0
        out[8] = 0
        out[9] = 0
        out[10] = k
        out[11] = 0
        out[12] = 0
        out[13] = 0
        out[14] = 0
        out[15] = 1
        return out
      }

      function fitView() {
        const n = state.count
        if (n === 0) return
        const pos = state.pos
        let maxR = 1
        for (let i = 0; i < n; i += 1) {
          const ix = i * 3
          const r = Math.sqrt(pos[ix] * pos[ix] + pos[ix + 1] * pos[ix + 1] + pos[ix + 2] * pos[ix + 2])
          if (r > maxR) maxR = r
        }
        const width = Math.max(1, canvas.clientWidth || 900)
        const height = Math.max(1, canvas.clientHeight || 600)
        const focal = 0.5 * height / Math.tan(FOV / 2)
        const fitted = (maxR * state.spread * 1.32 * focal) / (Math.min(width, height) * 0.4)
        const dist = Math.max(48, Math.min(300, fitted))
        state.dist = dist
        state.targetDist = dist
        state.fitDist = dist
      }

      function computeMatrices(width, height) {
        const aspect = width / Math.max(1, height)
        const proj = perspective(new Float32Array(16), FOV, aspect, 0.1, 900)
        const view = new Float32Array(16)
        // Spin the cloud around its own centre first, then push it in front of the
        // camera. Rotating after the translation would swing the whole cloud around
        // the camera instead, which is why it used to drift out of frame.
        const spin = new Float32Array(16)
        const ry = rotationY(new Float32Array(16), state.yaw)
        const rx = rotationX(new Float32Array(16), state.pitch)
        multiply(spin, ry, rx)
        // Pull the orbit centre onto the picked node before spinning, so the camera
        // circles that node instead of the middle of the whole cloud.
        const focus = translation(new Float32Array(16), -state.focus[0], -state.focus[1], -state.focus[2])
        const centred = new Float32Array(16)
        multiply(centred, spin, focus)
        // Spreading is a pure scale about the orbit centre: after the focus translation
        // the centre is the origin, so scaling here widens every wire without moving
        // the node the camera is circling.
        multiply(centred, scaling(new Float32Array(16), state.spread), centred)
        const t = translation(new Float32Array(16), 0, 0, -state.dist)
        multiply(view, t, centred)
        const vp = new Float32Array(16)
        multiply(vp, proj, view)
        return vp
      }

      function projectAll(vp, width, height) {
        const n = state.count
        const pos = state.pos
        const sx = state.sx
        const sy = state.sy
        const depth = state.depth
        const radii = state.radii
        const focal = 0.5 * height / Math.tan(FOV / 2)
        state.focalCss = focal
        for (let i = 0; i < n; i += 1) {
          const ix = i * 3
          const x = pos[ix]
          const y = pos[ix + 1]
          const z = pos[ix + 2]
          const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15]
          const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12]
          const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13]
          if (cw <= 0.05) {
            depth[i] = -1
            sx[i] = -9999
            sy[i] = -9999
            radii[i] = 0
            continue
          }
          depth[i] = cw
          sx[i] = (cx / cw * 0.5 + 0.5) * width
          sy[i] = (0.5 - cy / cw * 0.5) * height
          radii[i] = (state.size[i] * state.scale * focal) / cw * 0.5 + 2
        }
      }

      function uploadNodes() {
        gl.bindBuffer(gl.ARRAY_BUFFER, nodeBuffers.position)
        gl.bufferData(gl.ARRAY_BUFFER, state.pos, gl.DYNAMIC_DRAW)
        gl.bindBuffer(gl.ARRAY_BUFFER, nodeBuffers.color)
        gl.bufferData(gl.ARRAY_BUFFER, state.color, gl.STATIC_DRAW)
        gl.bindBuffer(gl.ARRAY_BUFFER, nodeBuffers.size)
        gl.bufferData(gl.ARRAY_BUFFER, state.size, gl.STATIC_DRAW)
        gl.bindBuffer(gl.ARRAY_BUFFER, nodeBuffers.alpha)
        gl.bufferData(gl.ARRAY_BUFFER, state.alpha, gl.DYNAMIC_DRAW)
      }

      function uploadLinks() {
        const pairs = state.pairs
        const pos = state.pos
        const verts = state.linkVerts
        const count = pairs.length / 2
        for (let k = 0; k < count; k += 1) {
          const i = pairs[k * 2] * 3
          const j = pairs[k * 2 + 1] * 3
          const o = k * 6
          verts[o] = pos[i]
          verts[o + 1] = pos[i + 1]
          verts[o + 2] = pos[i + 2]
          verts[o + 3] = pos[j]
          verts[o + 4] = pos[j + 1]
          verts[o + 5] = pos[j + 2]
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, linkBuffers.position)
        gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW)
        gl.bindBuffer(gl.ARRAY_BUFFER, linkBuffers.color)
        gl.bufferData(gl.ARRAY_BUFFER, state.linkColor, gl.STATIC_DRAW)
        gl.bindBuffer(gl.ARRAY_BUFFER, linkBuffers.alpha)
        gl.bufferData(gl.ARRAY_BUFFER, state.linkAlpha, gl.STATIC_DRAW)
      }

      /** Rebuild the particle roster after the graph changes. */
      function rebuildFlow() {
        const edges = state.lessonEdges
        let count = 0
        if (edges.length > 0) {
          const per = Math.max(1, Math.min(FLOW_PER_EDGE, Math.floor(FLOW_MAX / edges.length)))
          for (let e = 0; e < edges.length; e += 1) {
            for (let k = 0; k < per && count < FLOW_MAX; k += 1, count += 1) {
              state.flowEdge[count] = e
              state.flowPhase[count] = (e * 0.37 + k / per) % 1
              state.flowSize[count] = 1
              state.flowAlpha[count] = 0
            }
          }
        }
        state.flowCount = count
      }

      /**
       * Advance every pulse along its pipeline. The pulse starts in the error's own
       * colour and turns violet as it reaches the retrospective — the visible shape
       * of "this failure is now understood".
       */
      function updateFlow(dt) {
        const count = state.flowCount
        if (count === 0) return
        const edges = state.lessonEdges
        const pos = state.pos
        const nodes = state.nodes
        const selected = state.selected
        for (let i = 0; i < count; i += 1) {
          const edge = edges[state.flowEdge[i]]
          if (!edge) continue
          const base = state.flowPhase[i] + FLOW_SPEED * dt
          const t = base - Math.floor(base)
          state.flowPhase[i] = t

          // Normal pipeline: error -> retrospective, colouring from the failure towards
          // violet. A stale pipeline runs the other way: the lesson flows back into the
          // mistake and burns red, which reads at a glance as "this one didn't hold".
          const stale = Boolean(edge.stale)
          const from3 = stale ? edge.retro * 3 : edge.error * 3
          const to3 = stale ? edge.error * 3 : edge.retro * 3
          const ax = pos[from3]
          const ay = pos[from3 + 1]
          const az = pos[from3 + 2]
          const bx = pos[to3]
          const by = pos[to3 + 1]
          const bz = pos[to3 + 2]
          const ease = t * t * (3 - 2 * t)
          // No bow at all: the link is a straight line, so the pulse has to be a point
          // on that line, otherwise it visibly floats off the wire.
          state.flowPos[i * 3] = ax + (bx - ax) * ease
          state.flowPos[i * 3 + 1] = ay + (by - ay) * ease
          state.flowPos[i * 3 + 2] = az + (bz - az) * ease

          const fresh = state.learnRetros.has(edge.retroId) ? state.learnBoost : 0
          let dim = 1
          if (selected) dim = nodes[edge.retro] && nodes[edge.retro].id === selected ? 1.5 : 0.22
          const fade = Math.pow(Math.sin(Math.PI * t), 0.45)
          state.flowSize[i] = (3.0 + fresh * 2.2 + (dim > 1 ? 0.9 : 0)) * (0.65 + 0.45 * fade)
          state.flowAlpha[i] = Math.min(1, fade * dim * (0.5 + fresh * 0.9))

          const from = stale ? KIND_COLOR.retro || [0.78, 0.62, 1] : KIND_COLOR[nodes[edge.error].kind] || [1, 0.6, 0.6]
          const to = stale ? STALE_COLOR : KIND_COLOR.retro || [0.78, 0.62, 1]
          const mix = Math.min(1, t * 1.18)
          state.flowColor[i * 3] = from[0] + (to[0] - from[0]) * mix
          state.flowColor[i * 3 + 1] = from[1] + (to[1] - from[1]) * mix
          state.flowColor[i * 3 + 2] = from[2] + (to[2] - from[2]) * mix
        }
        if (state.learnBoost > 0) state.learnBoost = Math.max(0, state.learnBoost - 0.006 * dt)
      }

      function uploadFlow() {
        gl.bindBuffer(gl.ARRAY_BUFFER, flowBuffers.position)
        gl.bufferData(gl.ARRAY_BUFFER, state.flowPos, gl.DYNAMIC_DRAW)
        gl.bindBuffer(gl.ARRAY_BUFFER, flowBuffers.color)
        gl.bufferData(gl.ARRAY_BUFFER, state.flowColor, gl.DYNAMIC_DRAW)
        gl.bindBuffer(gl.ARRAY_BUFFER, flowBuffers.size)
        gl.bufferData(gl.ARRAY_BUFFER, state.flowSize, gl.DYNAMIC_DRAW)
        gl.bindBuffer(gl.ARRAY_BUFFER, flowBuffers.alpha)
        gl.bufferData(gl.ARRAY_BUFFER, state.flowAlpha, gl.DYNAMIC_DRAW)
      }

      function draw(vp) {
        const width = canvas.width
        const height = canvas.height
        gl.viewport(0, 0, width, height)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.disable(gl.DEPTH_TEST)
        gl.enable(gl.BLEND)
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE)

        const focalDevice = state.focalCss * state.dpr

        if (state.pairs.length > 0) {
          uploadLinks()
          gl.useProgram(linkProgram)
          gl.uniformMatrix4fv(linkLoc.uVP, false, vp)
          gl.uniform1f(linkLoc.uAlphaMul, 0.68)
          gl.bindBuffer(gl.ARRAY_BUFFER, linkBuffers.position)
          gl.enableVertexAttribArray(linkLoc.position)
          gl.vertexAttribPointer(linkLoc.position, 3, gl.FLOAT, false, 0, 0)
          gl.bindBuffer(gl.ARRAY_BUFFER, linkBuffers.color)
          gl.enableVertexAttribArray(linkLoc.color)
          gl.vertexAttribPointer(linkLoc.color, 3, gl.FLOAT, false, 0, 0)
          gl.bindBuffer(gl.ARRAY_BUFFER, linkBuffers.alpha)
          gl.enableVertexAttribArray(linkLoc.alpha)
          gl.vertexAttribPointer(linkLoc.alpha, 1, gl.FLOAT, false, 0, 0)
          gl.drawArrays(gl.LINES, 0, state.pairs.length)
        }

        // Pulses ride on top of the lesson edges, under the nodes that own them.
        if (state.flowCount > 0) {
          uploadFlow()
          gl.useProgram(nodeProgram)
          gl.uniformMatrix4fv(nodeLoc.uVP, false, vp)
          gl.uniform1f(nodeLoc.uFocal, focalDevice)
          gl.uniform1f(nodeLoc.uRefDist, state.fitDist || 96)
          gl.uniform1f(nodeLoc.uSizeMul, state.flowScale)
          gl.uniform1f(nodeLoc.uAlphaMul, 1.0)
          gl.bindBuffer(gl.ARRAY_BUFFER, flowBuffers.position)
          gl.enableVertexAttribArray(nodeLoc.position)
          gl.vertexAttribPointer(nodeLoc.position, 3, gl.FLOAT, false, 0, 0)
          gl.bindBuffer(gl.ARRAY_BUFFER, flowBuffers.color)
          gl.enableVertexAttribArray(nodeLoc.color)
          gl.vertexAttribPointer(nodeLoc.color, 3, gl.FLOAT, false, 0, 0)
          gl.bindBuffer(gl.ARRAY_BUFFER, flowBuffers.size)
          gl.enableVertexAttribArray(nodeLoc.size)
          gl.vertexAttribPointer(nodeLoc.size, 1, gl.FLOAT, false, 0, 0)
          gl.bindBuffer(gl.ARRAY_BUFFER, flowBuffers.alpha)
          gl.enableVertexAttribArray(nodeLoc.alpha)
          gl.vertexAttribPointer(nodeLoc.alpha, 1, gl.FLOAT, false, 0, 0)
          gl.drawArrays(gl.POINTS, 0, state.flowCount)
        }

        if (state.count > 0) {
          uploadNodes()
          gl.useProgram(nodeProgram)
          gl.uniformMatrix4fv(nodeLoc.uVP, false, vp)
          gl.uniform1f(nodeLoc.uFocal, focalDevice)
          gl.uniform1f(nodeLoc.uRefDist, state.fitDist || 96)
          gl.bindBuffer(gl.ARRAY_BUFFER, nodeBuffers.position)
          gl.enableVertexAttribArray(nodeLoc.position)
          gl.vertexAttribPointer(nodeLoc.position, 3, gl.FLOAT, false, 0, 0)
          gl.bindBuffer(gl.ARRAY_BUFFER, nodeBuffers.color)
          gl.enableVertexAttribArray(nodeLoc.color)
          gl.vertexAttribPointer(nodeLoc.color, 3, gl.FLOAT, false, 0, 0)
          gl.bindBuffer(gl.ARRAY_BUFFER, nodeBuffers.size)
          gl.enableVertexAttribArray(nodeLoc.size)
          gl.vertexAttribPointer(nodeLoc.size, 1, gl.FLOAT, false, 0, 0)
          gl.bindBuffer(gl.ARRAY_BUFFER, nodeBuffers.alpha)
          gl.enableVertexAttribArray(nodeLoc.alpha)
          gl.vertexAttribPointer(nodeLoc.alpha, 1, gl.FLOAT, false, 0, 0)

          gl.uniform1f(nodeLoc.uMaxSize, 44.0)
          gl.uniform1f(nodeLoc.uSizeMul, state.scale)
          gl.uniform1f(nodeLoc.uAlphaMul, 0.95)

          if (haloProgram && state.halo > 0.02) {
            gl.useProgram(haloProgram)
            gl.uniformMatrix4fv(haloLoc.uVP, false, vp)
            gl.uniform1f(haloLoc.uFocal, focalDevice)
            gl.uniform1f(haloLoc.uRefDist, state.fitDist || 96)
            gl.uniform1f(haloLoc.uMaxSize, 420.0)
            gl.bindBuffer(gl.ARRAY_BUFFER, nodeBuffers.position)
            gl.enableVertexAttribArray(haloLoc.position)
            gl.vertexAttribPointer(haloLoc.position, 3, gl.FLOAT, false, 0, 0)
            gl.bindBuffer(gl.ARRAY_BUFFER, nodeBuffers.color)
            gl.enableVertexAttribArray(haloLoc.color)
            gl.vertexAttribPointer(haloLoc.color, 3, gl.FLOAT, false, 0, 0)
            gl.bindBuffer(gl.ARRAY_BUFFER, nodeBuffers.size)
            gl.enableVertexAttribArray(haloLoc.size)
            gl.vertexAttribPointer(haloLoc.size, 1, gl.FLOAT, false, 0, 0)
            gl.bindBuffer(gl.ARRAY_BUFFER, nodeBuffers.alpha)
            gl.enableVertexAttribArray(haloLoc.alpha)
            gl.vertexAttribPointer(haloLoc.alpha, 1, gl.FLOAT, false, 0, 0)
            // Two additive layers make a bulb, not an airbrush: a tight bright corona
            // plus a wide faint spill.
            gl.uniform1f(haloLoc.uSizeMul, (1.0 + 1.7 * state.halo) * state.scale)
            gl.uniform1f(haloLoc.uAlphaMul, 0.42 * Math.min(1.3, state.halo))
            gl.drawArrays(gl.POINTS, 0, state.count)
            gl.uniform1f(haloLoc.uSizeMul, (2.3 + 4.4 * state.halo) * state.scale)
            gl.uniform1f(haloLoc.uAlphaMul, 0.13 * Math.min(1.5, state.halo))
            gl.drawArrays(gl.POINTS, 0, state.count)

            // Attribute state is global in WebGL1, so the node pass has to re-bind its
            // own pointers after the halo program used the same buffers.
            gl.useProgram(nodeProgram)
            gl.bindBuffer(gl.ARRAY_BUFFER, nodeBuffers.position)
            gl.enableVertexAttribArray(nodeLoc.position)
            gl.vertexAttribPointer(nodeLoc.position, 3, gl.FLOAT, false, 0, 0)
            gl.bindBuffer(gl.ARRAY_BUFFER, nodeBuffers.color)
            gl.enableVertexAttribArray(nodeLoc.color)
            gl.vertexAttribPointer(nodeLoc.color, 3, gl.FLOAT, false, 0, 0)
            gl.bindBuffer(gl.ARRAY_BUFFER, nodeBuffers.size)
            gl.enableVertexAttribArray(nodeLoc.size)
            gl.vertexAttribPointer(nodeLoc.size, 1, gl.FLOAT, false, 0, 0)
            gl.bindBuffer(gl.ARRAY_BUFFER, nodeBuffers.alpha)
            gl.enableVertexAttribArray(nodeLoc.alpha)
            gl.vertexAttribPointer(nodeLoc.alpha, 1, gl.FLOAT, false, 0, 0)
          }

          gl.drawArrays(gl.POINTS, 0, state.count)
        }

      }

      function setLabels(visible) {
        state.showLabels = visible !== false
        labelHost.style.display = state.showLabels ? '' : 'none'
      }

      function syncLabels(width, height) {
        if (!state.showLabels) return
        for (const node of state.labelNodes) {
          const el = state.labels.get(node.id)
          if (!el) continue
          if (state.hiddenKinds.has(node.kind)) {
            el.style.opacity = '0'
            continue
          }
          const idx = state.byId.get(node.id)
          if (idx === undefined || state.depth[idx] <= 0) {
            el.style.opacity = '0'
            continue
          }
          const x = state.sx[idx]
          const y = state.sy[idx]
          const outside = x < -80 || y < -40 || x > width + 80 || y > height + 40
          if (outside) {
            el.style.opacity = '0'
            continue
          }
          el.style.opacity = node.id === state.hovered || node.id === state.selected ? '1' : '0.72'
          el.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px) translate(-50%,-50%)'
        }
      }

      function frame(now) {
        if (state.disposed) return
        state.raf = window.requestAnimationFrame(frame)

        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const cssWidth = Math.max(1, canvas.clientWidth)
        const cssHeight = Math.max(1, canvas.clientHeight)
        const wantW = Math.round(cssWidth * dpr)
        const wantH = Math.round(cssHeight * dpr)
        if (canvas.width !== wantW || canvas.height !== wantH) {
          canvas.width = wantW
          canvas.height = wantH
        }
        state.dpr = dpr
        // Rotate by elapsed time: a fixed per-frame step runs 2.4x faster on a
        // 144Hz display than the °/s readout claims.
        const stamp = typeof now === 'number' ? now : state.lastFrame + 16.667
        const rawDt = state.lastFrame ? stamp - state.lastFrame : 16.667
        state.lastFrame = stamp
        const dt = Math.max(0.04, Math.min(4, rawDt / 16.667))
        state.clock += 0.0166 * dt

        if (state.count > 0 && !state.paused) {
          if (state.warmup > 0) {
            for (let s = 0; s < 5; s += 1) {
              simulate()
              state.warmup -= 1
              if (state.warmup <= 0) break
            }
          } else if (state.simBudget > 0) {
            for (let s = 0; s < 2; s += 1) simulate()
            state.simBudget -= 2
            if (!state.dragging) state.yaw += SPIN_MAX * state.spin * dt
          } else if (!state.dragging) {
            state.yaw += SPIN_MAX * state.spin * dt
          }
          if (state.needsFit && state.warmup <= 0) {
            state.needsFit = false
            fitView()
          }
          updateFlow(dt)
        }
        // frame-rate independent easing: 0.08 per 60Hz frame
        state.dist += (state.targetDist - state.dist) * (1 - Math.pow(0.92, dt))
          const focusEase = 1 - Math.pow(0.86, dt)
          for (let k = 0; k < 3; k += 1) state.focus[k] += (state.focusTarget[k] - state.focus[k]) * focusEase

        if (state.alphaDirty) {
          const sel = state.selected
          const matches = state.matches
          for (let i = 0; i < state.count; i += 1) {
            const id = state.nodes[i].id
            if (!sel) state.alpha[i] = state.baseAlpha[i]
            else if (id === sel) state.alpha[i] = 1
            else if (state.neighbors.has(id)) state.alpha[i] = 0.85
            else state.alpha[i] = 0.1
            if (matches) state.alpha[i] = matches.has(id) ? Math.max(state.alpha[i], 0.95) : state.alpha[i] * 0.12
            if (state.hiddenKinds.size > 0 && state.hiddenKinds.has(state.nodes[i].kind)) state.alpha[i] = 0
          }
          state.alphaDirty = false
        }

        const vp = computeMatrices(cssWidth, cssHeight)
        projectAll(vp, cssWidth, cssHeight)
        draw(vp)
        syncLabels(cssWidth, cssHeight)
      }

      // ── data ────────────────────────────────────────────────────────────────
      function setData(payload) {
        const nodes = (payload && Array.isArray(payload.nodes) ? payload.nodes : []).map((node) => ({ ...node }))
        const rawLinks = (payload && Array.isArray(payload.links) ? payload.links : []).slice()
        // The DSH core sits in the middle of the atlas. Older host halves do not emit
        // it yet, so synthesize it here: every hub, and every unanchored error, links
        // to it. Once the host sends one this block is a no-op.
        if (nodes.length > 0 && !nodes.some((node) => node.kind === 'root')) {
          let total = 0
          for (const node of nodes) total += node.count || 0
          nodes.push({ id: 'root:dsh', kind: 'root', label: 'DSH', count: total })
          const anchored = new Set()
          for (const link of rawLinks) {
            anchored.add(String(link && link.s))
            anchored.add(String(link && link.t))
          }
          for (const node of nodes) {
            if (node.kind === 'root') continue
            if (isHubNode(node.kind) || !anchored.has(node.id)) rawLinks.push({ s: node.id, t: 'root:dsh' })
          }
        }
        const signature =
          nodes.map((node) => node.id + ':' + node.kind + ':' + (node.count || 0)).join('|') +
          '#' +
          rawLinks.map((link) => String(link && link.s) + '>' + String(link && link.t)).join('|')
        if (state.signature === signature && state.count === nodes.length) return
        state.signature = signature

        // keep the previous layout so a refreshed payload does not reshuffle the cloud
        const previous = new Map()
        for (let i = 0; i < state.count; i += 1) {
          previous.set(state.nodes[i].id, [state.pos[i * 3], state.pos[i * 3 + 1], state.pos[i * 3 + 2]])
        }

        const byId = new Map()
        nodes.forEach((node, index) => {
          byId.set(node.id, index)
        })
        state.indexById = byId
        const links = []
        const pairs = []
        const linkColor = []
        const linkAlpha = []
        const linkRoles = []
        for (const link of rawLinks) {
          const a = byId.get(link && link.s)
          const b = byId.get(link && link.t)
          if (a === undefined || b === undefined) continue
          // A lesson edge joins a retrospective to the failures it came from: violet, a
          // little brighter, so the causal pairs stand out from the hub spokes. If the
          // lesson did not hold (the error came back), the edge turns warning red.
          const lesson = Boolean(link && link.kind === 'lesson')
          links.push({ a, b, lesson })
          pairs.push(a, b)
          if (lesson) {
            const stale = Boolean(nodes[a] && nodes[a].recurred > 0)
            const lc = stale ? STALE_COLOR : KIND_COLOR.retro || [0.78, 0.62, 1]
            linkColor.push(lc[0], lc[1], lc[2], lc[0], lc[1], lc[2])
            linkAlpha.push(stale ? 0.66 : 0.46, stale ? 0.66 : 0.46)
            linkRoles.push('lesson')
            continue
          }
          const ca = KIND_COLOR[nodes[a].kind] || [1, 1, 1]
          const cb = KIND_COLOR[nodes[b].kind] || [1, 1, 1]
          linkColor.push((ca[0] + cb[0]) * 0.5, (ca[1] + cb[1]) * 0.5, (ca[2] + cb[2]) * 0.5)
          linkColor.push((ca[0] + cb[0]) * 0.5, (ca[1] + cb[1]) * 0.5, (ca[2] + cb[2]) * 0.5)
          // The tether to a satellite is drawn a little brighter than a hub spoke:
          // it is the only thing that tells you which ball the program belongs to.
          // Spokes to the core are the most numerous edges in the graph, so they stay
          // dim: the islands should be readable before the web around the core is.
          const satelliteEdge = nodes[a].kind === 'project' || nodes[b].kind === 'project'
          const rootSpoke = nodes[a].kind === 'root' || nodes[b].kind === 'root'
          const alpha = satelliteEdge ? 0.34 : rootSpoke ? 0.16 : 0.26
          linkAlpha.push(alpha, alpha)
          linkRoles.push(satelliteEdge ? 'project' : rootSpoke ? 'core' : 'hub')
        }

        const count = nodes.length
        // Lesson edges are pipelines: the particle passes run from the error node to
        // the retrospective that learned from it.
        const edges = []
        for (const link of links) {
          if (!link.lesson) continue
          const retroNode = nodes[link.a]
          edges.push({
            retro: link.a,
            error: link.b,
            retroId: retroNode ? retroNode.id : '',
            // A stale pipeline runs the other way: the mistake is flowing back in.
            stale: Boolean(retroNode && retroNode.recurred > 0),
          })
        }
        state.lessonEdges = edges
        rebuildFlow()
        // A retrospective that this payload introduced is a learning event: its
        // pipeline glows so the user sees the moment an error was understood.
        const retroIds = new Set(nodes.filter((node) => node.kind === 'retro').map((node) => node.id))
        const fresh = []
        for (const id of retroIds) if (!state.knownRetros.has(id)) fresh.push(id)
        if (fresh.length > 0 && state.knownRetros.size > 0) {
          state.learnRetros = new Set(fresh)
          state.learnBoost = 1
        }
        state.knownRetros = retroIds
        state.nodes = nodes
        state.byId = byId
        state.links = links
        state.count = count
        state.pos = new Float32Array(count * 3)
        state.vel = new Float32Array(count * 3)
        state.mass = new Float32Array(count)
        state.size = new Float32Array(count)
        state.color = new Float32Array(count * 3)
        state.alpha = new Float32Array(count)
        state.baseAlpha = new Float32Array(count)
        state.pairs = new Int32Array(pairs)
        state.linkVerts = new Float32Array(links.length * 6)
        state.linkColor = new Float32Array(linkColor)
        state.linkAlpha = new Float32Array(linkAlpha)
        state.linkBaseAlpha = Float32Array.from(linkAlpha)
        state.linkRoles = linkRoles
        state.sx = new Float32Array(count)
        state.sy = new Float32Array(count)
        state.depth = new Float32Array(count)
        state.radii = new Float32Array(count)

        for (let i = 0; i < count; i += 1) {
          const color = KIND_COLOR[nodes[i].kind] || [0.9, 0.9, 0.9]
          state.color[i * 3] = color[0]
          state.color[i * 3 + 1] = color[1]
          state.color[i * 3 + 2] = color[2]
          state.baseAlpha[i] = isHubNode(nodes[i].kind) ? 0.94 : 0.74
          state.alpha[i] = state.baseAlpha[i]
        }
        for (let i = 0; i < count; i += 1) {
          // the core is drawn as a black hole, not as another dust mote
          if (nodes[i].kind !== 'root') continue
          state.size[i] = 0
          state.baseAlpha[i] = 0
          state.alpha[i] = 0
        }
        state.selected = null
        state.hovered = null
        state.neighbors = new Set()
        state.alphaDirty = true

        initLayout(previous)
        state.needsFit = true

        // Retrospectives are the newest and most meaningful leaves, so they earn
        // labels before the older error dust.
        const seenLabel = new Set()
        const labelCandidates = nodes
          .filter((node) => node.kind === 'retro')
          .slice(0, 6)
          .concat(nodes.filter((node) => isHubNode(node.kind) && node.kind !== 'root'))
          .concat(nodes.filter((node) => !isHubNode(node.kind) && node.kind !== 'retro').slice(0, 10))
          .filter((node) => {
            if (seenLabel.has(node.id)) return false
            seenLabel.add(node.id)
            return true
          })
        ensureLabels(labelCandidates)
      }

      function setSelected(id) {
        state.selected = id
        state.neighbors = new Set()
        if (id) {
          const index = state.byId.get(id)
          if (index !== undefined) {
            for (const link of state.links) {
              if (link.a === index) state.neighbors.add(state.nodes[link.b].id)
              if (link.b === index) state.neighbors.add(state.nodes[link.a].id)
            }
          }
        }
        state.alphaDirty = true
      }

      function setHovered(id) {
        state.hovered = id
      }

      // A query is matched against everything a node knows about itself: the visible
      // label, the tool name, the message, the kind, the session, and the retrospective
      // text. Returns how many nodes matched so the panel can say it out loud.
      function nodeHaystack(node) {
        const parts = [node.label, node.name, node.message, node.kind]
        if (node.sessionId) parts.push('session ' + node.sessionId)
        if (node.retro) parts.push(node.retro.title, node.retro.lesson, node.retro.done)
        return parts.filter((part) => typeof part === 'string' && part).join(' ').toLowerCase()
      }

      function setQuery(query) {
        const needle = String(query || '').trim().toLowerCase()
        if (!needle) {
          state.matches = null
        } else {
          const set = new Set()
          for (let i = 0; i < state.count; i += 1) {
            const node = state.nodes[i]
            if (node.kind === 'root') continue
            if (nodeHaystack(node).includes(needle)) set.add(node.id)
          }
          state.matches = set
        }
        state.alphaDirty = true
        return state.matches ? state.matches.size : 0
      }

      function hitTest(clientX, clientY) {
        const rect = canvas.getBoundingClientRect()
        const x = clientX - rect.left
        const y = clientY - rect.top
        let best = -1
        let bestScore = Infinity
        for (let i = 0; i < state.count; i += 1) {
          if (state.depth[i] <= 0) continue
          if (state.nodes[i].kind === 'root') continue
          const dx = state.sx[i] - x
          const dy = state.sy[i] - y
          const radius = Math.max(9, state.radii[i])
          const d2 = dx * dx + dy * dy
          if (d2 > radius * radius) continue
          const score = d2 / (radius * radius)
          if (score < bestScore) {
            bestScore = score
            best = i
          }
        }
        return best >= 0 ? state.nodes[best] : null
      }

      /** Circle the camera around one node: its position becomes the orbit centre. */
      function focusOn(node) {
        if (!node || !state.indexById) return false
        const index = state.indexById.get(node.id)
        if (index === undefined) return false
        state.focusTarget[0] = state.pos[index * 3]
        state.focusTarget[1] = state.pos[index * 3 + 1]
        state.focusTarget[2] = state.pos[index * 3 + 2]
        // Close in until the picked node is clearly the subject: small nodes pull the
        // camera quite close, hubs stay a little further out so their satellites fit.
        const size = state.size[index] || 4
        state.targetDist = Math.max(12, Math.min(state.targetDist, 26 + size * 1.7))
        return true
      }

      function clearFocus() {
                state.focusTarget[0] = 0
        state.focusTarget[1] = 0
        state.focusTarget[2] = 0
        state.targetDist = state.fitDist || 96
      }

      function resetView() {
        state.yaw = 0.55
        state.pitch = -0.14
        state.targetDist = 96
        state.warmup = 120
        state.simBudget = 0
        state.needsFit = true
        clearFocus()
      }

      function relayout() {
        initLayout()
      }

      // ── input ───────────────────────────────────────────────────────────────
      function onPointerDown(event) {
        if (event.button !== 0) return
        state.dragging = true
        state.moved = 0
        state.lastX = event.clientX
        state.lastY = event.clientY
        try {
          canvas.setPointerCapture(event.pointerId)
        } catch {
          /* capture is best effort */
        }
      }

      function onPointerMove(event) {
        if (state.dragging) {
          const dx = event.clientX - state.lastX
          const dy = event.clientY - state.lastY
          state.lastX = event.clientX
          state.lastY = event.clientY
          state.moved += Math.abs(dx) + Math.abs(dy)
          state.yaw -= dx * 0.0055
          state.pitch = Math.max(-1.3, Math.min(1.3, state.pitch + dy * 0.0045))
          return
        }
        const node = hitTest(event.clientX, event.clientY)
        if ((node && node.id) !== state.hovered) {
          state.hovered = node ? node.id : null
          canvas.style.cursor = node ? 'pointer' : 'grab'
          if (handlers && typeof handlers.onHover === 'function') handlers.onHover(node)
        }
      }

      function onPointerUp(event) {
        if (!state.dragging) return
        state.dragging = false
        try {
          canvas.releasePointerCapture(event.pointerId)
        } catch {
          /* ignore */
        }
        if (state.moved > 6) return
                const node = hitTest(event.clientX, event.clientY)
        // Where you click is what you orbit: the picked node becomes the camera centre,
        // and a click on empty space returns the camera to the middle of the cloud.
        if (node) focusOn(node)
        else clearFocus()
        if (handlers && typeof handlers.onPick === 'function') handlers.onPick(node)
      }

      function onPointerLeave() {
        if (state.hovered === null) return
        state.hovered = null
        if (handlers && typeof handlers.onHover === 'function') handlers.onHover(null)
      }

      // A single click selects (the card explains), a double click acts: it opens the
      // session the node came from. Two gestures keep inspection and navigation apart.
      function onDoubleClick(event) {
        if (typeof handlers.onOpen !== 'function') return
        handlers.onOpen(hitTest(event.clientX, event.clientY))
      }

      function onWheel(event) {
        event.preventDefault()
        const factor = Math.exp((event.deltaY || 0) * 0.0021)
        state.targetDist = Math.max(12, Math.min(420, state.targetDist * factor))
      }

      function onContextMenu(event) {
        event.preventDefault()
      }

      canvas.addEventListener('pointerdown', onPointerDown)
      canvas.addEventListener('pointermove', onPointerMove)
      canvas.addEventListener('pointerup', onPointerUp)
      canvas.addEventListener('pointercancel', onPointerUp)
      canvas.addEventListener('pointerleave', onPointerLeave)
      canvas.addEventListener('wheel', onWheel, { passive: false })
      canvas.addEventListener('contextmenu', onContextMenu)
      canvas.addEventListener('dblclick', onDoubleClick)
      canvas.style.cursor = 'grab'

      state.raf = window.requestAnimationFrame(frame)

      return {
        ok: true,
        setData,
        setSelected,
        setHovered,
        setQuery,
        setLabels,
        hitTest,
                resetView,
        focusOn,
        clearFocus,
        relayout,
        // Test hook only: lets a headless harness inspect the live render state.
        __state: () => state,
                setScale(value) {
          state.scale = Math.max(0.08, Math.min(3, Number(value) || 1))
        },

        setHalo(value) {
          state.halo = Math.max(0, Math.min(4, Number(value) || 0))
        },

        setFlowScale(value) {
          state.flowScale = Math.max(0.2, Math.min(4, Number(value) || 1))
        },

        setSpread(value) {
          state.spread = Math.max(0.35, Math.min(2.4, Number(value) || 1))
        },

        setFilters(nodeKinds, linkRoles) {
          state.hiddenKinds = new Set(Array.isArray(nodeKinds) ? nodeKinds : [])
          state.hiddenLinks = new Set(Array.isArray(linkRoles) ? linkRoles : [])
          state.alphaDirty = true
          const base = state.linkBaseAlpha
          if (base && state.linkAlpha) {
            for (let i = 0; i < state.linkRoles.length; i += 1) {
              const off = state.hiddenLinks.has(state.linkRoles[i]) ? 0 : 1
              state.linkAlpha[i * 2] = base[i * 2] * off
              state.linkAlpha[i * 2 + 1] = base[i * 2 + 1] * off
            }
            uploadLinks()
          }
        },

        setSpin(value) {
          const next = Number(value)
          if (!Number.isFinite(next)) return
          state.spin = Math.max(0, Math.min(1, next))
        },
        setPaused(value) {
          state.paused = Boolean(value)
        },
        dispose() {
          state.disposed = true
          window.cancelAnimationFrame(state.raf)
          canvas.removeEventListener('pointerdown', onPointerDown)
          canvas.removeEventListener('pointermove', onPointerMove)
          canvas.removeEventListener('pointerup', onPointerUp)
          canvas.removeEventListener('pointercancel', onPointerUp)
          canvas.removeEventListener('pointerleave', onPointerLeave)
          canvas.removeEventListener('wheel', onWheel)
          canvas.removeEventListener('contextmenu', onContextMenu)
          canvas.removeEventListener('dblclick', onDoubleClick)
          for (const el of state.labels.values()) if (el.parentNode) el.parentNode.removeChild(el)
          state.labels.clear()
          gl.deleteBuffer(nodeBuffers.position)
          gl.deleteBuffer(nodeBuffers.color)
          gl.deleteBuffer(nodeBuffers.size)
          gl.deleteBuffer(nodeBuffers.alpha)
          gl.deleteBuffer(linkBuffers.position)
          gl.deleteBuffer(linkBuffers.color)
          gl.deleteBuffer(linkBuffers.alpha)
          gl.deleteProgram(nodeProgram)
          gl.deleteProgram(linkProgram)
        },
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // styles
    // ─────────────────────────────────────────────────────────────────────────
    const CSS = `
.dshea-root {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background:
    radial-gradient(90% 70% at 18% 82%, rgba(255, 143, 163, 0.08) 0%, rgba(0, 0, 0, 0) 60%),
    #05060a;
  color: #eceef3;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  isolation: isolate;
}
.dshea-root::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.026) 0px, rgba(255, 255, 255, 0.026) 1px, rgba(0, 0, 0, 0) 1px, rgba(0, 0, 0, 0) 3px);
  mix-blend-mode: overlay;
  opacity: 0.55;
  z-index: 3;
}
.dshea-header {
  position: relative;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 16px 11px;
  border-bottom: 1px solid transparent;
  background: transparent;
  flex: 0 0 auto;
  flex-wrap: wrap;
}
.dshea-brand { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dshea-title {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.34em;
  color: #f4f5f8;
  text-shadow: 0 0 14px rgba(255, 77, 90, 0.35);
  text-transform: uppercase;
}
.dshea-sub { font-size: 10px; letter-spacing: 0.16em; color: rgba(236, 238, 243, 0.46); text-transform: uppercase; }
.dshea-rec { display: inline-flex; align-items: center; gap: 6px; font-size: 9px; letter-spacing: 0.22em; color: #ff5566; }
.dshea-rec-dot { width: 6px; height: 6px; border-radius: 50%; background: #ff4d5a; box-shadow: 0 0 8px #ff4d5a; animation: dshea-pulse 2.4s ease-in-out infinite; }
@keyframes dshea-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
.dshea-stats { display: flex; align-items: stretch; gap: 0; margin-left: 6px; flex-wrap: wrap; }
.dshea-stat { display: flex; flex-direction: column; gap: 2px; padding: 0 12px; border-left: 1px solid rgba(255, 255, 255, 0.08); }
.dshea-stat:first-child { border-left: 0; padding-left: 0; }
.dshea-stat-value { font-size: 14px; font-weight: 600; color: #fbfbfd; letter-spacing: 0.04em; font-variant-numeric: tabular-nums; }
.dshea-stat-label { font-size: 9px; letter-spacing: 0.16em; color: rgba(236, 238, 243, 0.42); text-transform: uppercase; }
.dshea-spacer { flex: 1 1 auto; }
.dshea-actions { display: flex; align-items: center; gap: 7px; }
.dshea-colors { display: flex; align-items: center; gap: 3px; padding: 2px 6px; border: 1px solid rgba(255, 122, 132, 0.16); border-radius: 999px; }
.dshea-colors-label { font: 600 8px/1 ui-monospace, monospace; letter-spacing: 0.14em; color: var(--dsw-alias-label-tertiary, #8a8f98); margin-right: 2px; }
.dshea-colors-count { font: 600 8px/1 ui-monospace, monospace; color: rgba(255, 255, 255, 0.32); margin-right: 2px; }
.dshea-chip {
  width: 10px;
  height: 10px;
  padding: 0;
  border: 1px solid var(--chip);
  border-radius: 50%;
  background: transparent;
  opacity: 0.34;
  cursor: pointer;
  transition: opacity 120ms ease, box-shadow 120ms ease;
}
.dshea-chip.is-on { opacity: 1; background: var(--chip); border-color: var(--chip); box-shadow: 0 0 6px var(--chip); }
.dshea-chip:not(.is-on) { border-style: dashed; opacity: 0.28; }
.dshea-chip:hover { opacity: 0.85; }
.dshea-style {
  display: none;
  position: absolute;
  top: 52px;
  right: 14px;
  z-index: 6;
  flex-direction: column;
  gap: 9px;
  min-width: 240px;
  padding: 12px 14px;
  border: 1px solid rgba(255, 122, 132, 0.28);
  border-radius: 10px;
  background: rgba(10, 8, 10, 0.94);
  box-shadow: 0 18px 42px rgba(0, 0, 0, 0.55);
}
.dshea-style.is-open { display: flex; }
.dshea-style .dshea-spin { justify-content: space-between; }
.dshea-style .dshea-range { flex: 1 1 auto; margin: 0 8px; }
.dshea-btn {
  appearance: none;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.05);
  color: rgba(240, 242, 247, 0.88);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
  white-space: nowrap;
}
.dshea-btn:hover { background: rgba(255, 255, 255, 0.1); border-color: rgba(255, 255, 255, 0.24); color: #fff; }
.dshea-btn:active { transform: translateY(1px); }
.dshea-btn.dshea-danger:hover { border-color: rgba(255, 77, 90, 0.55); background: rgba(255, 77, 90, 0.12); color: #ffd0d4; }
.dshea-btn[disabled] { opacity: 0.4; cursor: default; }
.dshea-spin { display: flex; align-items: center; gap: 7px; padding: 0 4px 0 2px; color: rgba(240, 242, 247, 0.62); font-size: 9px; letter-spacing: 0.16em; text-transform: uppercase; white-space: nowrap; }
.dshea-build { padding: 1px 5px; border: 1px solid rgba(255, 124, 141, 0.42); border-radius: 3px; color: rgba(255, 150, 160, 0.92); font-size: 8px; letter-spacing: 0.12em; }
.dshea-spin-value { min-width: 30px; font-variant-numeric: tabular-nums; color: rgba(240, 242, 247, 0.86); }
.dshea-spin-rate { min-width: 44px; font-size: 9px; letter-spacing: 0.04em; color: rgba(255, 214, 150, 0.8); font-variant-numeric: tabular-nums; text-transform: none; }
.dshea-btn.dshea-pause.is-on { border-color: rgba(255, 214, 150, 0.6); background: rgba(255, 214, 150, 0.16); color: #ffe4b8; }
  .dshea-btn.dshea-caption.is-on { border-color: rgba(255, 77, 90, 0.55); background: rgba(255, 77, 90, 0.16); color: #ffb3ba; }
.dshea-range {
  appearance: none;
  -webkit-appearance: none;
  width: 96px;
  height: 16px;
  margin: 0;
  background: transparent;
  outline: none;
  cursor: pointer;
}
.dshea-range::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: 2px;
  background: linear-gradient(90deg, rgba(255, 214, 150, 0.85), rgba(255, 77, 90, 0.55));
}
.dshea-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  margin-top: -4.5px;
  border-radius: 50%;
  background: #ffe9c4;
  box-shadow: 0 0 9px rgba(255, 220, 160, 0.95);
  cursor: grab;
}
.dshea-range:active::-webkit-slider-thumb { cursor: grabbing; }
.dshea-range::-moz-range-track {
  height: 3px;
  border-radius: 2px;
  background: linear-gradient(90deg, rgba(255, 214, 150, 0.85), rgba(255, 77, 90, 0.55));
}
.dshea-range::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border: none;
  border-radius: 50%;
  background: #ffe9c4;
  box-shadow: 0 0 9px rgba(255, 220, 160, 0.95);
  cursor: grab;
}
.dshea-stage { position: relative; flex: 1 1 auto; min-height: 300px; }
.dshea-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
.dshea-labels { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 2; }
.dshea-label {
  position: absolute;
  top: 0;
  left: 0;
  transform: translate(-9999px, -9999px);
  font-size: 9px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  white-space: nowrap;
  color: rgba(255, 235, 237, 0.78);
  text-shadow: 0 0 6px rgba(255, 60, 80, 0.55), 0 0 14px rgba(255, 60, 80, 0.3);
  transition: opacity 260ms ease;
  will-change: transform;
}
.dshea-label.is-hub { font-size: 10px; letter-spacing: 0.2em; color: rgba(255, 255, 255, 0.95); text-shadow: 0 0 8px rgba(255, 255, 255, 0.55); }
      .dshea-label.is-stale { color: #ff9a8d; text-shadow: 0 0 8px rgba(255, 91, 77, 0.55); }
.dshea-legend {
  position: absolute;
  left: 14px;
  top: 12px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 9px 11px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 5px;
  background: rgba(6, 7, 11, 0.55);
  backdrop-filter: blur(6px);
  pointer-events: none;
}
.dshea-legend-row { display: flex; align-items: center; gap: 8px; font-size: 9px; letter-spacing: 0.16em; color: rgba(236, 238, 243, 0.62); text-transform: uppercase; }
.dshea-legend-dot { width: 7px; height: 7px; border-radius: 50%; }
.dshea-hint {
  position: absolute;
  left: 14px;
  bottom: 12px;
  z-index: 2;
  font-size: 9px;
  letter-spacing: 0.14em;
  color: rgba(236, 238, 243, 0.34);
  text-transform: uppercase;
  pointer-events: none;
}
.dshea-hint.is-paused { color: rgba(255, 196, 92, 0.72); }
.dshea-notice {
  position: absolute;
  left: 14px;
  bottom: 34px;
  z-index: 3;
  max-width: min(560px, calc(100% - 28px));
  padding: 7px 10px;
  border: 1px solid rgba(199, 164, 255, 0.34);
  border-radius: 5px;
  background: rgba(18, 12, 28, 0.86);
  color: rgba(226, 214, 255, 0.92);
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 10px;
  line-height: 1.5;
  word-break: break-all;
  pointer-events: none;
}
.dshea-card {
  position: absolute;
  right: 14px;
  top: 12px;
  z-index: 3;
  width: min(320px, 46%);
  max-height: calc(100% - 24px);
  overflow: auto;
  padding: 12px 13px;
  border: 1px solid rgba(255, 90, 105, 0.32);
  border-radius: 6px;
  background: linear-gradient(180deg, rgba(24, 8, 12, 0.92), rgba(8, 9, 13, 0.92));
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 77, 90, 0.08) inset;
  backdrop-filter: blur(8px);
}
.dshea-card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.dshea-card-kind { font-size: 9px; letter-spacing: 0.2em; padding: 2px 6px; border-radius: 3px; border: 1px solid currentColor; }
.dshea-card-name { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; color: #f7f8fb; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshea-card-close { margin-left: auto; cursor: pointer; color: rgba(255, 255, 255, 0.45); font-size: 13px; line-height: 1; padding: 2px 4px; border-radius: 3px; }
.dshea-card-close:hover { color: #fff; background: rgba(255, 255, 255, 0.1); }
/* Card actions sit left of the close button: open the source session, or mute a signature. */
.dshea-card-act {
  margin-left: auto;
  cursor: pointer;
  font-size: 9px;
  letter-spacing: 0.12em;
  padding: 2px 7px;
  border-radius: 3px;
  color: #ffc6cf;
  border: 1px solid rgba(255, 77, 90, 0.42);
  background: rgba(255, 77, 90, 0.1);
  white-space: nowrap;
}
.dshea-card-act:hover { color: #fff; border-color: rgba(255, 77, 90, 0.8); background: rgba(255, 77, 90, 0.2); }
.dshea-card-act.is-quiet { color: rgba(236, 238, 243, 0.62); border-color: rgba(255, 255, 255, 0.16); background: rgba(255, 255, 255, 0.05); }
.dshea-card-act.is-quiet:hover { color: #fff; }
.dshea-card-act + .dshea-card-close { margin-left: 4px; }
.dshea-filter { gap: 6px; }
.dshea-select {
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.06em;
  color: #eceef3;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 4px;
  padding: 2px 4px;
  cursor: pointer;
}
.dshea-select:hover { border-color: rgba(255, 255, 255, 0.3); }
.dshea-select option { background: #14151a; color: #eceef3; }
.dshea-search {
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.04em;
  color: #eceef3;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 4px;
  padding: 3px 7px;
  width: 150px;
  outline: none;
}
.dshea-search:focus { border-color: rgba(127, 212, 255, 0.6); background: rgba(127, 212, 255, 0.08); }
.dshea-search::placeholder { color: rgba(236, 238, 243, 0.32); }
.dshea-match { font-size: 10px; letter-spacing: 0.06em; color: rgba(127, 212, 255, 0.9); font-variant-numeric: tabular-nums; }
.dshea-match.is-empty { color: rgba(255, 154, 141, 0.9); }
.dshea-trend {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(6, 7, 10, 0.6);
  position: relative;
  z-index: 4;
}
.dshea-trend-title { font-size: 10px; letter-spacing: 0.14em; color: rgba(236, 238, 243, 0.45); text-transform: uppercase; }
.dshea-trend-bars { flex: 1; display: flex; align-items: flex-end; gap: 2px; height: 26px; }
.dshea-trend-bar {
  flex: 1;
  min-height: 1px;
  border-radius: 1px 1px 0 0;
  background: linear-gradient(180deg, rgba(255, 120, 132, 0.95), rgba(255, 77, 90, 0.45));
}
.dshea-trend-bar.is-zero { background: rgba(255, 255, 255, 0.09); }
.dshea-trend-note { font-size: 9px; letter-spacing: 0.05em; color: rgba(236, 238, 243, 0.32); white-space: nowrap; }
.dshea-board { flex: 0 0 auto; border-top: 1px solid rgba(255, 255, 255, 0.06); background: rgba(6, 7, 10, 0.6); position: relative; z-index: 4; }
.dshea-board-head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 14px 6px; background: transparent; border: 0; font: inherit; color: inherit; text-align: left; cursor: pointer; }
.dshea-board-head:hover { background: rgba(255, 255, 255, 0.03); }
.dshea-board-caret { width: 9px; font-size: 9px; color: rgba(236, 238, 243, 0.42); }
.dshea-board-title { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(236, 238, 243, 0.45); }
.dshea-board-sum { margin-left: auto; font-size: 10px; letter-spacing: 0.04em; color: rgba(255, 154, 141, 0.8); font-variant-numeric: tabular-nums; }
.dshea-board-sum.is-clean { color: rgba(120, 255, 200, 0.7); }
.dshea-board-body { display: flex; flex-direction: column; gap: 4px; padding: 0 14px 9px; }
.dshea-board-group { margin-top: 3px; font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: rgba(236, 238, 243, 0.3); }
.dshea-board-row { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.dshea-board-row:hover .dshea-board-name { color: rgba(236, 238, 243, 0.9); }
.dshea-board-name { width: 96px; flex: 0 0 96px; font-size: 10px; color: rgba(236, 238, 243, 0.55); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshea-board-track { flex: 1; height: 6px; border-radius: 3px; background: rgba(255, 255, 255, 0.06); overflow: hidden; }
.dshea-board-fill { display: block; height: 100%; border-radius: 3px; background: linear-gradient(90deg, rgba(255, 77, 90, 0.85), rgba(255, 154, 141, 0.5)); }
.dshea-board-fill.is-clean { background: linear-gradient(90deg, rgba(120, 255, 200, 0.5), rgba(120, 255, 200, 0.22)); }
.dshea-board-count { width: 92px; flex: 0 0 92px; text-align: right; font-size: 10px; color: rgba(236, 238, 243, 0.38); font-variant-numeric: tabular-nums; }
.dshea-board-empty { font-size: 10px; color: rgba(236, 238, 243, 0.34); }
      .dshea-memory { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 6px 14px; border-top: 1px solid rgba(255, 255, 255, 0.06); background: rgba(6, 7, 10, 0.5); position: relative; z-index: 4; }
      .dshea-memory-title { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(236, 238, 243, 0.34); }
      .dshea-switch { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px 3px 7px; border-radius: 999px; border: 1px solid rgba(255, 255, 255, 0.1); background: rgba(255, 255, 255, 0.02); color: rgba(236, 238, 243, 0.42); font-family: inherit; font-size: 10px; letter-spacing: 0.06em; cursor: pointer; transition: color 0.18s ease, border-color 0.18s ease, background 0.18s ease; }
      .dshea-switch:hover { color: rgba(236, 238, 243, 0.72); border-color: rgba(255, 255, 255, 0.2); }
      .dshea-switch-dot { width: 5px; height: 5px; border-radius: 50%; background: rgba(236, 238, 243, 0.26); transition: background 0.18s ease, box-shadow 0.18s ease; }
      .dshea-switch.is-on { color: rgba(255, 214, 216, 0.92); border-color: rgba(255, 77, 90, 0.42); background: rgba(255, 77, 90, 0.1); }
      .dshea-switch.is-on .dshea-switch-dot { background: #ff4d5a; box-shadow: 0 0 7px rgba(255, 77, 90, 0.8); }
.dshea-card-msg {
  font-size: 11px;
  line-height: 1.55;
  color: rgba(236, 238, 243, 0.86);
  word-break: break-word;
  margin-bottom: 10px;
}
.dshea-card-grid { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; font-size: 10px; }
.dshea-card-k { letter-spacing: 0.14em; color: rgba(236, 238, 243, 0.4); text-transform: uppercase; }
.dshea-card-v { color: rgba(236, 238, 243, 0.82); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; }
.dshea-card-field { display: flex; gap: 9px; padding: 4px 0; border-top: 1px solid rgba(255, 255, 255, 0.05); }
.dshea-card-field .dshea-card-k { flex: 0 0 42px; padding-top: 1px; }
.dshea-card-field .dshea-card-v { white-space: normal; line-height: 1.5; word-break: break-word; }
      .dshea-card-v.is-stale { color: #ff6b5e; }
.dshea-log { flex: 0 0 auto; border-top: 1px solid rgba(255, 255, 255, 0.08); background: rgba(4, 5, 8, 0.72); position: relative; z-index: 4; display: flex; flex-direction: column; min-height: 0; }
.dshea-log-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 14px;
  cursor: pointer;
  user-select: none;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
.dshea-log-title { font-size: 10px; letter-spacing: 0.24em; text-transform: uppercase; color: rgba(236, 238, 243, 0.72); }
.dshea-log-sub { font-size: 9px; letter-spacing: 0.16em; color: rgba(236, 238, 243, 0.32); text-transform: uppercase; }
.dshea-log-toggle { margin-left: auto; font-size: 9px; letter-spacing: 0.16em; color: rgba(236, 238, 243, 0.42); text-transform: uppercase; }
.dshea-rows { overflow: auto; max-height: 172px; min-height: 0; }
.dshea-row {
  display: grid;
  grid-template-columns: 62px 62px minmax(0, 132px) minmax(0, 1fr) 46px;
  align-items: baseline;
  gap: 10px;
  padding: 4px 14px;
  font-size: 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.035);
  cursor: pointer;
  transition: background 100ms ease;
}
.dshea-row:hover { background: rgba(255, 77, 90, 0.08); }
.dshea-row-time { color: rgba(236, 238, 243, 0.34); font-variant-numeric: tabular-nums; }
.dshea-row-kind { font-size: 9px; letter-spacing: 0.16em; }
.dshea-row-name { color: rgba(236, 238, 243, 0.72); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshea-row-msg { color: rgba(236, 238, 243, 0.52); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshea-row-count { text-align: right; color: rgba(255, 120, 132, 0.72); font-variant-numeric: tabular-nums; }
.dshea-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  text-align: center;
  padding: 24px;
  z-index: 2;
  pointer-events: none;
}
.dshea-empty-title { font-size: 13px; letter-spacing: 0.42em; color: rgba(255, 120, 132, 0.85); text-transform: uppercase; text-shadow: 0 0 18px rgba(255, 77, 90, 0.45); }
.dshea-empty-hint { font-size: 11px; color: rgba(236, 238, 243, 0.62); letter-spacing: 0.06em; }
.dshea-empty-detail { max-width: 460px; font-size: 10px; line-height: 1.7; color: rgba(236, 238, 243, 0.4); letter-spacing: 0.04em; }
.dshea-error { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 3; text-align: center; font-size: 11px; color: #ffb3ba; letter-spacing: 0.06em; }
.dshea-rows::-webkit-scrollbar, .dshea-card::-webkit-scrollbar { width: 8px; }
.dshea-rows::-webkit-scrollbar-thumb, .dshea-card::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.14); border-radius: 4px; }
@media (max-width: 720px) {
  .dshea-row { grid-template-columns: 54px 52px minmax(0, 1fr) 34px; }
  .dshea-row-name { display: none; }
  .dshea-legend { display: none; }
}
`

    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return () => {}
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
      return () => {
        if (style.parentNode) style.parentNode.removeChild(style)
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // sidebar icon
    // ─────────────────────────────────────────────────────────────────────────
    function AtlasIcon(props) {
      const size = (props && props.size) || 16
      const active = Boolean(props && props.active)
      const accent = active ? '#ff5566' : 'currentColor'
      const dim = active ? 'rgba(255,120,132,0.75)' : 'currentColor'
      const o = active ? 1 : 0.85
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
        h('g', { stroke: dim, strokeWidth: 1, opacity: o, strokeLinecap: 'round' },
          h('line', { x1: 12, y1: 11.2, x2: 6.4, y2: 6.4 }),
          h('line', { x1: 12, y1: 11.2, x2: 17.6, y2: 6.9 }),
          h('line', { x1: 12, y1: 11.2, x2: 17.2, y2: 16.6 }),
          h('line', { x1: 12, y1: 11.2, x2: 6.9, y2: 16.9 }),
        ),
        h('circle', { cx: 6.4, cy: 6.4, r: 1.7, fill: dim, opacity: o }),
        h('circle', { cx: 17.6, cy: 6.9, r: 1.4, fill: dim, opacity: o }),
        h('circle', { cx: 17.2, cy: 16.6, r: 1.8, fill: dim, opacity: o }),
        h('circle', { cx: 6.9, cy: 16.9, r: 1.3, fill: dim, opacity: o }),
        h('circle', { cx: 12, cy: 11.2, r: 2.9, fill: accent, opacity: 0.22 }),
        h('circle', { cx: 12, cy: 11.2, r: 1.8, fill: accent }),
      )
    }

    // ─────────────────────────────────────────────────────────────────────────
    // panel
    // ─────────────────────────────────────────────────────────────────────────
    function ErrorAtlasPanel() {
      const [data, setData] = useState(() => withDev(null))
      const [failure, setFailure] = useState(null)
      const [selectedId, setSelectedId] = useState(null)
      const [focusedLabel, setFocusedLabel] = useState(null)
      const [hoveredNode, setHoveredNode] = useState(null)
      const [showLog, setShowLog] = useState(true)
      const [scale, setScale] = useState(() => {
        try {
          const raw = Number(window.localStorage.getItem('dsh-error-atlas-scale'))
          return Number.isFinite(raw) && raw >= 10 && raw <= 300 ? raw : 100
        } catch {
          return 100
        }
      })
      const [flowScale, setFlowScale] = useState(() => {
        try {
          const raw = Number(window.localStorage.getItem('dsh-error-atlas-flow'))
          return Number.isFinite(raw) && raw >= 20 && raw <= 400 ? raw : 100
        } catch {
          return 100
        }
      })
      const [spread, setSpread] = useState(() => {
        try {
          const raw = Number(window.localStorage.getItem('dsh-error-atlas-spread'))
          return Number.isFinite(raw) && raw >= 35 && raw <= 240 ? raw : 100
        } catch {
          return 100
        }
      })
      const readFilters = (key) => {
        try {
          const raw = window.localStorage.getItem(key)
          const list = raw ? JSON.parse(raw) : []
          return Array.isArray(list) ? list.filter((item) => typeof item === 'string') : []
        } catch {
          return []
        }
      }
      const [offKinds, setOffKinds] = useState(() => readFilters('dsh-error-atlas-off-kinds'))
      const [offLinks, setOffLinks] = useState(() => readFilters('dsh-error-atlas-off-links'))
      const offKindsRef = useRef(offKinds)
      const offLinksRef = useRef(offLinks)
      offKindsRef.current = offKinds
      offLinksRef.current = offLinks
      const [styleOpen, setStyleOpen] = useState(false)
      const [halo, setHalo] = useState(() => {
        try {
          const raw = Number(window.localStorage.getItem('dsh-error-atlas-halo'))
          return Number.isFinite(raw) && raw >= 0 && raw <= 400 ? raw : 100
        } catch {
          return 100
        }
      })
      const [spin, setSpin] = useState(() => {
        try {
          const saved = Number(window.localStorage.getItem('dsh-error-atlas-spin'))
          if (Number.isFinite(saved) && saved >= 0 && saved <= 100) return saved
        } catch {
          /* storage can be unavailable; the default still works */
        }
        return 20
      })
      const [paused, setPaused] = useState(false)
      const pausedRef = useRef(false)
      const [labels, setLabelsShown] = useState(() => {
        try {
          if (window.localStorage.getItem('dsh-error-atlas-labels') === '0') return false
        } catch {
          /* storage can be unavailable; the captions stay on */
        }
        return true
      })
      const labelsRef = useRef(labels)
      const [busy, setBusy] = useState(false)
      const [renderFallback, setRenderFallback] = useState(false)
      const [notice, setNotice] = useState('')
      const [minHits, setMinHits] = useState(1)
      const [query, setQueryText] = useState('')
      const [matchCount, setMatchCount] = useState(0)
      const [trendMode, setTrendMode] = useState('hour')
      // The lesson leaderboard is the only block that can grow, so it remembers whether
      // it was collapsed: a reader who does not care about the ranking keeps the graph.
      const [boardOpen, setBoardOpen] = useState(() => {
        try {
          return window.localStorage.getItem('dsh-error-atlas-board') !== '0'
        } catch {
          return true
        }
      })
      const toggleBoard = useCallback(() => {
        setBoardOpen((open) => {
          const next = !open
          try {
            window.localStorage.setItem('dsh-error-atlas-board', next ? '1' : '0')
          } catch {
            /* private mode: the panel still works, the choice just does not stick */
          }
          return next
        })
      }, [])
      const queryRef = useRef('')
      const noticeTimer = useRef(null)
      // COPY resolves against the active locale at render time, so a language switch only
      // needs a re-render: subscribe once and nudge a revision counter.
      const [, setLocaleRevision] = useState(0)
      useEffect(() => {
        const locale = localeService
        if (!locale || typeof locale.subscribe !== 'function') return undefined
        try {
          const snapshot = typeof locale.getLocale === 'function' ? locale.getLocale() : null
          if (snapshot && typeof snapshot.active === 'string' && snapshot.active) activeLocale = snapshot.active.slice(0, 2)
        } catch {
          /* keep the previous language */
        }
        return locale.subscribe(() => {
          try {
            const snapshot = typeof locale.getLocale === 'function' ? locale.getLocale() : null
            if (snapshot && typeof snapshot.active === 'string' && snapshot.active) activeLocale = snapshot.active.slice(0, 2)
          } catch {
            /* keep the previous language */
          }
          setLocaleRevision((value) => value + 1)
          // The author's defects are merged into the payload, so their language is
          // resolved at merge time: re-merge from the raw host copy on a switch.
          if (rawRef.current) setData(withDev(rawRef.current))
        })
      }, [])

      const canvasRef = useRef(null)
      const labelHostRef = useRef(null)
      const rendererRef = useRef(null)
      const dataRef = useRef(null)
      // The last host payload before the author's defects are merged in: a language
      // switch re-merges from this copy instead of stacking a second set of nodes.
      const rawRef = useRef(null)

      const load = useCallback(async () => {
        try {
          const response = await fetch(DATA_PATH, { cache: 'no-store', headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const payload = await response.json()
          rawRef.current = payload
          setData(withDev(payload))
          if (payload && payload.prefs && Number.isFinite(payload.prefs.minCount)) setMinHits(payload.prefs.minCount)
          setFailure(null)
          return payload
        } catch (error) {
          setFailure(error && error.message ? error.message : String(error))
          return null
        }
      }, [])

      useEffect(() => {
        let alive = true
        const run = async () => {
          if (!alive) return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          await load()
        }
        run()
        const timer = window.setInterval(run, POLL_MS)
        return () => {
          alive = false
          window.clearInterval(timer)
        }
      }, [load])

      // create the renderer once
      useEffect(() => {
        const canvas = canvasRef.current
        const labelHost = labelHostRef.current
        if (!canvas || !labelHost) return undefined
        let renderer = null
        try {
          renderer = createRenderer(canvas, labelHost, {
            onHover: (node) => setHoveredNode(node || null),
                  onPick: (node) => {
              const next = node ? node.id : null
              setSelectedId(next)
              setHoveredNode(node || null)
              setFocusedLabel(node ? String(node.label || node.name || node.id).slice(0, 30) : null)
            },
            onOpen: (node) => {
              const id = sessionIdOf(node)
              if (id) openAtlasSession(id)
            },
          })
        } catch (error) {
          console.error('[error-atlas] renderer init failed', error)
        }
        if (!renderer) {
          setRenderFallback(true)
          return undefined
        }
        rendererRef.current = renderer
        renderer.setLabels(labelsRef.current)
        if (dataRef.current) renderer.setData(dataRef.current)
        if (queryRef.current) setMatchCount(renderer.setQuery(queryRef.current))
        return () => {
          rendererRef.current = null
          renderer.dispose()
        }
      }, [])

      // push data into the renderer
      useEffect(() => {
        dataRef.current = data
        const renderer = rendererRef.current
        if (!renderer || !data) return
        renderer.setData(data)
        // A query survives a poll: the lens is re-applied over the new snapshot.
        setMatchCount(renderer.setQuery(queryRef.current))
        setSelectedId(null)
        setHoveredNode(null)
      }, [data])

      const onQuery = useCallback((value) => {
        queryRef.current = value
        setQueryText(value)
        const renderer = rendererRef.current
        setMatchCount(renderer ? renderer.setQuery(value) : 0)
      }, [])

      useEffect(() => {
        const renderer = rendererRef.current
        if (renderer) renderer.setSelected(selectedId)
      }, [selectedId])

      useEffect(() => {
        const renderer = rendererRef.current
        if (renderer) renderer.setSpin(spin / 100)
          if (renderer) renderer.setScale(scale / 100)
          if (renderer) renderer.setHalo(halo / 100)
          if (renderer) renderer.setFlowScale(flowScale / 100)
          if (renderer) renderer.setSpread(spread / 100)
          if (renderer) renderer.setFilters(offKindsRef.current, offLinksRef.current)
      }, [spin])

      useEffect(() => {
        const renderer = rendererRef.current
        if (renderer) renderer.setPaused(paused)
      }, [paused])

      const onToggleLabels = useCallback(() => {
        // Same shape as the pause switch: the renderer is the source of truth,
        // React only mirrors it for the button state and the saved preference.
        const next = !labelsRef.current
        labelsRef.current = next
        const renderer = rendererRef.current
        if (renderer) renderer.setLabels(next)
        setLabelsShown(next)
        try {
          window.localStorage.setItem('dsh-error-atlas-labels', next ? '1' : '0')
        } catch {
          /* best effort only */
        }
      }, [])

      const onTogglePause = useCallback(() => {
        // The renderer is the source of truth for the freeze, so the click is
        // applied immediately and the React state only mirrors it for the label.
        const next = !pausedRef.current
        pausedRef.current = next
        const renderer = rendererRef.current
        if (renderer) renderer.setPaused(next)
        setPaused(next)
      }, [])

      const toggleKind = useCallback((kind) => {
        const next = offKindsRef.current.includes(kind)
          ? offKindsRef.current.filter((item) => item !== kind)
          : offKindsRef.current.concat(kind)
        setOffKinds(next)
        try {
          window.localStorage.setItem('dsh-error-atlas-off-kinds', JSON.stringify(next))
        } catch {
          /* storage is best effort */
        }
        if (rendererRef.current) rendererRef.current.setFilters(next, offLinksRef.current)
      }, [])

      const toggleLink = useCallback((role) => {
        const next = offLinksRef.current.includes(role)
          ? offLinksRef.current.filter((item) => item !== role)
          : offLinksRef.current.concat(role)
        setOffLinks(next)
        try {
          window.localStorage.setItem('dsh-error-atlas-off-links', JSON.stringify(next))
        } catch {
          /* storage is best effort */
        }
        if (rendererRef.current) rendererRef.current.setFilters(offKindsRef.current, next)
      }, [])

      const onSpread = useCallback((value) => {
        const next = Math.max(35, Math.min(240, Number(value) || 100))
        setSpread(next)
        try {
          window.localStorage.setItem('dsh-error-atlas-spread', String(next))
        } catch {
          /* storage is best effort */
        }
        if (rendererRef.current) rendererRef.current.setSpread(next / 100)
      }, [])

      const onFlowScale = useCallback((value) => {
        const next = Math.max(20, Math.min(400, Number(value) || 100))
        setFlowScale(next)
        try {
          window.localStorage.setItem('dsh-error-atlas-flow', String(next))
        } catch {
          /* storage is best effort */
        }
        if (rendererRef.current) rendererRef.current.setFlowScale(next / 100)
      }, [])

      const onHalo = useCallback((value) => {
        const next = Math.max(0, Math.min(400, Number(value) || 0))
        setHalo(next)
        try {
          window.localStorage.setItem('dsh-error-atlas-halo', String(next))
        } catch {
          /* storage is best effort */
        }
        if (rendererRef.current) rendererRef.current.setHalo(next / 100)
      }, [])

      const onScale = useCallback((value) => {
        const next = Math.max(10, Math.min(300, Number(value) || 100))
        setScale(next)
        try {
          window.localStorage.setItem('dsh-error-atlas-scale', String(next))
        } catch {
          /* storage is best effort */
        }
        if (rendererRef.current) rendererRef.current.setScale(next / 100)
      }, [])

      const onSpin = useCallback((value) => {
        const next = Number(value)
        if (!Number.isFinite(next)) return
        setSpin(next)
        const renderer = rendererRef.current
        if (renderer) {
          renderer.setSpin(next / 100)
          // Resuming by dragging is what people expect: a speed change while
          // paused puts the atlas back in motion at the new speed.
          if (pausedRef.current) {
            pausedRef.current = false
            renderer.setPaused(false)
            setPaused(false)
          }
        }
        try {
          window.localStorage.setItem('dsh-error-atlas-spin', String(next))
        } catch {
          /* best effort only */
        }
      }, [])

      const nodesById = useMemo(() => {
        const map = new Map()
        if (data && Array.isArray(data.nodes)) for (const node of data.nodes) map.set(node.id, node)
        return map
      }, [data])

      const selectedNode = selectedId ? nodesById.get(selectedId) || null : null
      const cardNode = selectedNode || hoveredNode

      const stats = (data && data.stats) || null
      const recent = (data && Array.isArray(data.recent) ? data.recent : []).slice(0, 120)
      const hasNodes = Boolean(data && Array.isArray(data.nodes) && data.nodes.length > 0)

      const onRefresh = useCallback(async () => {
        setBusy(true)
        await load()
        setBusy(false)
      }, [load])

      const onRelayout = useCallback(() => {
        const renderer = rendererRef.current
        if (renderer) renderer.relayout()
      }, [])

      const onClear = useCallback(async () => {
        if (!window.confirm(COPY.clearConfirm)) return
        setBusy(true)
        try {
          await fetch(CLEAR_PATH, { method: 'POST', cache: 'no-store' })
        } catch {
          /* the reload below surfaces any real failure */
        }
        await load()
        setBusy(false)
      }, [load])

      // The export runs on the host, which owns the data directory: the panel only
      // shows the path it wrote, so the file can be opened or committed later.
      const onExport = useCallback(async () => {
        setBusy(true)
        let text = COPY.exportFailed
        try {
          const response = await fetch(EXPORT_PATH, { method: 'POST', cache: 'no-store' })
          const body = await response.json().catch(() => null)
          if (response.ok && body && body.ok) text = COPY.exported + ' · ' + body.path
        } catch {
          /* the notice below reports it */
        }
        setNotice(text)
        setBusy(false)
        if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
        noticeTimer.current = window.setTimeout(() => {
          noticeTimer.current = null
          setNotice('')
        }, 12000)
      }, [])

      useEffect(
        () => () => {
          if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
        },
        [],
      )

      // Noise rules live on the host, so every window and the CLI agree on what the
      // atlas shows; the panel only mirrors the answer.
      const pushPrefs = useCallback(
        async (patch) => {
          setBusy(true)
          try {
            const response = await fetch(PREFS_PATH, {
              method: 'POST',
              cache: 'no-store',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(patch),
            })
            const body = await response.json().catch(() => null)
            if (!body || !body.ok) setNotice(COPY.ignoreFailed)
          } catch {
            setNotice(COPY.ignoreFailed)
          }
          await load()
          setBusy(false)
        },
        [load],
      )

      const onMinHits = useCallback(
        (value) => {
          const next = Number(value)
          if (!Number.isFinite(next)) return
          setMinHits(next)
          pushPrefs({ minCount: next })
        },
        [pushPrefs],
      )

      const onIgnore = useCallback(
        (node) => {
          if (!node || !window.confirm(COPY.ignoreConfirm)) return
          const rule = truncate(String(node.message || node.name || ''), 60).trim()
          if (!rule) {
            setNotice(COPY.ignoreEmpty)
            return
          }
          const current = data && data.prefs && Array.isArray(data.prefs.ignore) ? data.prefs.ignore : []
          const next = current.includes(rule) ? current : current.concat([rule])
          setSelectedId(null)
          setNotice(COPY.ignored + ' · ' + rule)
          pushPrefs({ ignore: next })
        },
        [data, pushPrefs],
      )

      const onOpenNode = useCallback((node) => {
        const id = sessionIdOf(node)
        if (id) openAtlasSession(id)
      }, [])

      const onRowClick = useCallback(
        (entry) => {
          if (!data) return
          const match = data.nodes.find(
            (node) => node.kind === entry.kind && node.name === entry.name && node.message === entry.message,
          )
          if (match) {
            setSelectedId(match.id)
            setHoveredNode(match)
          }
        },
        [data],
      )

      const rateLabel = paused ? '0.0°/s' : ((spin / 100) * SPIN_DEG_PER_SEC).toFixed(1) + '°/s'

      const chipRow = (label, items, off, onToggle) =>
        h(
          'div',
          { className: 'dshea-colors', title: label },
          h('span', { className: 'dshea-colors-label' }, label),
          h('span', { className: 'dshea-colors-count' }, items.length - off.length + '/' + items.length),
          items.map(([value, color, name]) =>
            h('button', {
              key: value,
              type: 'button',
              className: 'dshea-chip' + (off.includes(value) ? '' : ' is-on'),
              style: { '--chip': color },
              title: (off.includes(value) ? '✕ ' : '✓ ') + (name || value),
              onClick: () => onToggle(value),
              'aria-pressed': off.includes(value) ? 'false' : 'true',
            }),
          ),
        )

      const header = h(
        'div',
        { className: 'dshea-header' },
        h(
          'div',
          { className: 'dshea-brand' },
          h('div', { className: 'dshea-title' }, h('span', null, COPY.title), h('span', { className: 'dshea-build' }, BUILD), h('span', { className: 'dshea-rec' }, h('span', { className: 'dshea-rec-dot' }), COPY.recording)),
          h('div', { className: 'dshea-sub' }, COPY.subtitle),
        ),
        h(
          'div',
          { className: 'dshea-stats' },
          statCell(COPY.total, stats ? fmtNumber(stats.total) : '—'),
          statCell(COPY.distinct, stats ? fmtNumber(stats.distinct) : '—'),
          statCell(COPY.nodes, stats ? fmtNumber(stats.shown) : '—'),
          statCell(COPY.sessions, stats ? fmtNumber(stats.sessions) : '—'),
          statCell(COPY.tools, stats ? fmtNumber(stats.tools) : '—'),
          statCell(COPY.projects, stats ? fmtNumber(stats.projects) : '—'),
          statCell(COPY.dev, stats ? fmtNumber(stats.dev) : '—'),
          statCell(COPY.retro, stats ? fmtNumber(stats.retro) : '—'),
          statCell(COPY.stale, stats ? fmtNumber(stats.stale) : '—'),
        ),
        h('div', { className: 'dshea-spacer' }),
        h(
          'div',
          { className: 'dshea-actions' },
          chipRow(
            COPY.nodeColors,
            [
              ['agent', '#ff4453', 'AGENT'],
              ['tool', '#ffb570', 'TOOL'],
              ['exit', '#ffd68f', 'EXIT'],
              ['config', '#d89eff', 'CONFIG'],
              ['sessionhub', '#ffd9e4', 'SESSION'],
              ['project', '#7fd4ff', 'PROJECT'],
              ['dev', '#7ff3e0', 'DEV'],
              ['retro', '#c7a4ff', 'RETRO'],
            ],
            offKinds,
            toggleKind,
          ),
          chipRow(
            COPY.linkColors,
            [
              ['core', '#ff6b6b', COPY.linkCore],
              ['hub', '#ffb570', COPY.linkHub],
              ['project', '#7fd4ff', COPY.linkProject],
              ['lesson', '#c7a4ff', COPY.linkLesson],
            ],
            offLinks,
            toggleLink,
          ),
          h('button', { type: 'button', className: 'dshea-btn', onClick: onRefresh, disabled: busy }, COPY.refresh),
          h('input', {
            type: 'search',
            className: 'dshea-search',
            placeholder: COPY.searchHint,
            value: query,
            spellCheck: false,
            onChange: (event) => onQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Escape') onQuery('')
            },
          }),
          query
            ? h(
                'span',
                { className: matchCount > 0 ? 'dshea-match' : 'dshea-match is-empty' },
                matchCount > 0 ? COPY.matched + ' ' + matchCount : COPY.noMatch,
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              className: paused ? 'dshea-btn dshea-pause is-on' : 'dshea-btn dshea-pause',
              onClick: onTogglePause,
            },
            paused ? COPY.resume : COPY.pause,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshea-btn dshea-style-btn' + (styleOpen ? ' is-on' : ''),
              onClick: () => setStyleOpen((open) => !open),
              'aria-expanded': styleOpen ? 'true' : 'false',
            },
            COPY.style,
          ),
          h(
            'label',
            { className: 'dshea-spin dshea-filter' },
            h('span', { className: 'dshea-spin-label' }, COPY.minHits),
            h(
              'select',
              {
                className: 'dshea-select',
                value: String(minHits),
                onChange: (event) => onMinHits(Number(event.target.value)),
              },
              [1, 2, 3, 5, 10].map((value) =>
                h('option', { key: value, value: String(value) }, value === 1 ? COPY.minHitsAll : '≥' + value),
              ),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshea-btn dshea-caption' + (labels ? ' is-on' : ''),
              onClick: onToggleLabels,
              title: COPY.labelsTip,
              'aria-pressed': labels ? 'true' : 'false',
            },
            COPY.labels,
          ),
          h('button', { type: 'button', className: 'dshea-btn', onClick: onRelayout, disabled: !hasNodes }, COPY.relayout),
          h('button', { type: 'button', className: 'dshea-btn', onClick: onExport, disabled: busy }, COPY.exportMarkdown),
          h('button', { type: 'button', className: 'dshea-btn dshea-danger', onClick: onClear, disabled: busy || !hasNodes }, COPY.clear),
        ),
      )

      const stylePanel = h(
        'div',
        { className: styleOpen ? 'dshea-style is-open' : 'dshea-style' },
                    h(
              'label',
              { className: 'dshea-spin' },
              h('span', { className: 'dshea-spin-label' }, COPY.spin),
              h('input', {
                type: 'range',
                min: 0,
                max: 100,
                step: 1,
                value: spin,
                className: 'dshea-range',
                // Both handlers on purpose: `onChange` is React's normal range
                // path, `onInput` keeps the control alive even if an intermediate
                // layer swallows the synthetic change event.
                onChange: (event) => onSpin(event.target.value),
                onInput: (event) => onSpin(event.target.value),
              }),
              h('span', { className: 'dshea-spin-value' }, Math.round(spin) + '%'),
              h('span', { className: 'dshea-spin-rate' }, rateLabel),
            ),
            h(
              'label',
              { className: 'dshea-spin dshea-size' },
              h('span', { className: 'dshea-spin-label' }, COPY.scale),
              h('input', {
                type: 'range',
                min: 10,
                max: 300,
                step: 5,
                value: scale,
                className: 'dshea-range',
                onChange: (event) => onScale(event.target.value),
                onInput: (event) => onScale(event.target.value),
              }),
              h('span', { className: 'dshea-spin-value' }, Math.round(scale) + '%'),
            ),
            h(
              'label',
              { className: 'dshea-spin dshea-halo' },
              h('span', { className: 'dshea-spin-label' }, COPY.halo),
              h('input', {
                type: 'range',
                min: 0,
                max: 400,
                step: 5,
                value: halo,
                className: 'dshea-range',
                onChange: (event) => onHalo(event.target.value),
                onInput: (event) => onHalo(event.target.value),
              }),
              h('span', { className: 'dshea-spin-value' }, Math.round(halo) + '%'),
            ),
        h(
          'label',
          { className: 'dshea-spin dshea-spread' },
          h('span', { className: 'dshea-spin-label' }, COPY.spread),
          h('input', {
            type: 'range',
            min: 35,
            max: 240,
            step: 5,
            value: spread,
            className: 'dshea-range',
            onChange: (event) => onSpread(event.target.value),
            onInput: (event) => onSpread(event.target.value),
          }),
          h('span', { className: 'dshea-spin-value' }, Math.round(spread) + '%'),
        ),
        h(
          'label',
          { className: 'dshea-spin dshea-flow' },
          h('span', { className: 'dshea-spin-label' }, COPY.flow),
          h('input', {
            type: 'range',
            min: 20,
            max: 400,
            step: 5,
            value: flowScale,
            className: 'dshea-range',
            onChange: (event) => onFlowScale(event.target.value),
            onInput: (event) => onFlowScale(event.target.value),
          }),
          h('span', { className: 'dshea-spin-value' }, Math.round(flowScale) + '%'),
        ),
      )

      const legend = h(
        'div',
        { className: 'dshea-legend' },
        legendRow(KIND_CSS.agent, 'AGENT'),
        legendRow(KIND_CSS.tool, 'TOOL'),
        legendRow(KIND_CSS.exit, 'EXIT'),
        legendRow(KIND_CSS.session, 'SESSION'),
        legendRow(KIND_CSS.config, 'CONFIG'),
          legendRow(KIND_CSS.dev, 'DEV'),
        legendRow(KIND_CSS.retro, 'RETRO'),
        legendRow(KIND_CSS.project, 'PROJECT'),
        legendRow(KIND_CSS.stale, 'STALE'),
      )

      // The hint carries the two honesty notes: how much of the graph is truncated and
      // how many signatures the noise rules are hiding, plus the navigation gesture.
      const hintBits = []
      if (focusedLabel) hintBits.push(fill(COPY.focused, { name: focusedLabel }))
      if (stats && stats.truncated > 0) {
        hintBits.push(fill(COPY.truncatedHint, { shown: stats.shown, cut: stats.truncated }))
      }
      if (stats && stats.muted > 0) hintBits.push(fill(COPY.mutedHint, { n: stats.muted }))
      if (hasNodes) hintBits.push(COPY.openSessionTip)
      const hintText = (paused ? COPY.hintPaused : COPY.hint) + (hintBits.length ? ' · ' + hintBits.join(' · ') : '')

      const stage = h(
        'div',
        { className: 'dshea-stage' },
        h('canvas', { ref: canvasRef, className: 'dshea-canvas' }),
        h('div', { ref: labelHostRef, className: 'dshea-labels' }),
        hasNodes ? legend : null,
        hasNodes ? h('div', { key: 'hint', className: paused ? 'dshea-hint is-paused' : 'dshea-hint' }, hintText) : null,
        !hasNodes && !failure
          ? h(
              'div',
              { className: 'dshea-empty' },
              h('div', { className: 'dshea-empty-title' }, COPY.empty),
              h('div', { className: 'dshea-empty-hint' }, COPY.emptyHint),
              h('div', { className: 'dshea-empty-detail' }, COPY.emptyDetail),
            )
          : null,
        failure
          ? h(
              'div',
              { className: 'dshea-error' },
              COPY.failed,
              h('div', { style: { marginTop: '6px', opacity: 0.6, fontSize: '10px' } }, failure),
            )
          : null,
        renderFallback
          ? h(
              'div',
              { className: 'dshea-error' },
              COPY.webglTitle,
              h('div', { style: { marginTop: '6px', opacity: 0.6, fontSize: '10px' } }, COPY.webglBody),
            )
          : null,
        notice ? h('div', { className: 'dshea-notice' }, notice) : null,
        cardNode ? renderCard(cardNode, selectedId, () => setSelectedId(null), onOpenNode, onIgnore) : null,
      )

      const logStrip = h(
        'div',
        { className: 'dshea-log' },
        h(
          'div',
          { className: 'dshea-log-head', onClick: () => setShowLog((value) => !value) },
          h('span', { className: 'dshea-log-title' }, COPY.recent),
          h('span', { className: 'dshea-log-sub' }, COPY.recentSub),
          h('span', { className: 'dshea-log-sub' }, recent.length + ' / ' + (data && data.stats ? data.stats.distinct : 0)),
          h('span', { className: 'dshea-log-toggle' }, showLog ? COPY.collapse : COPY.expand),
        ),
        showLog
          ? h(
              'div',
              { className: 'dshea-rows' },
              recent.length === 0
                ? h('div', { style: { padding: '10px 14px', fontSize: '10px', color: 'rgba(236,238,243,0.35)' } }, COPY.emptyHint)
                : recent.map((entry, index) =>
                    h(
                      'div',
                      {
                        key: String(entry.at) + '-' + index,
                        className: 'dshea-row',
                        onClick: () => onRowClick(entry),
                      },
                      h('span', { className: 'dshea-row-time' }, clock(entry.at)),
                      h('span', { className: 'dshea-row-kind', style: { color: KIND_CSS[entry.kind] || '#fff' } }, KIND_TEXT[entry.kind] || 'ERR'),
                      h('span', { className: 'dshea-row-name' }, entry.name && entry.name !== '-' ? entry.name : '—'),
                      h('span', { className: 'dshea-row-msg' }, truncate(entry.message, 140)),
                      h('span', { className: 'dshea-row-count' }, '×' + fmtNumber(entry.count)),
                    ),
                  ),
            )
          : null,
      )

      const trend = data && data.trend
      const trendBars = trend ? (trendMode === 'hour' ? trend.hour : trend.day) : []
      const trendPeak = trendBars.reduce((max, value) => Math.max(max, value), 0)
      const newSignatures = trend && Array.isArray(trend.first) ? trend.first.reduce((sum, value) => sum + value, 0) : 0
      const trendRow = trend
        ? h(
            'div',
            { className: 'dshea-trend' },
            h('span', { className: 'dshea-trend-title' }, COPY.activity),
            h(
              'div',
              { className: 'dshea-trend-bars' },
              trendBars.map((value, index) => {
                const ago = trendBars.length - 1 - index
                const label =
                  trendMode === 'hour' ? (ago === 0 ? COPY.now : '-' + ago + 'h') : ago === 0 ? COPY.today : '-' + ago + 'd'
                return h('div', {
                  key: index,
                  className: value > 0 ? 'dshea-trend-bar' : 'dshea-trend-bar is-zero',
                  title: label + ' · ' + value,
                  style: {
                    height: (trendPeak > 0 ? Math.round((value / trendPeak) * 100) : 0) + '%',
                    opacity: value > 0 ? 1 : 0.5,
                  },
                })
              }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dshea-btn',
                onClick: () => setTrendMode(trendMode === 'hour' ? 'day' : 'hour'),
              },
              trendMode === 'hour' ? COPY.trendHour : COPY.trendDay,
            ),
            trendMode === 'day' ? h('span', { className: 'dshea-trend-note' }, COPY.trendNew + ' ' + newSignatures) : null,
            h('span', { className: 'dshea-trend-note' }, trend.capped ? COPY.trendCapped : COPY.trendNote),
          )
        : null

      // The leaderboard answers the only question that matters about a lesson library:
      // which categories of lesson actually stuck. Rows are clickable so a bad tag
      // turns straight into a filtered graph instead of a dead number.
      const boardData = data && data.lessons ? data.lessons : null
      const boardRow = (cell, kind) =>
        h(
          'div',
          {
            key: kind + ':' + cell.name,
            className: 'dshea-board-row',
            title: cell.name,
            onClick: () => onQuery(cell.name),
          },
          h('span', { className: 'dshea-board-name' }, cell.name),
          h(
            'span',
            { className: 'dshea-board-track' },
            h('span', {
              className: cell.failed > 0 ? 'dshea-board-fill' : 'dshea-board-fill is-clean',
              style: { width: Math.max(cell.rate, cell.failed > 0 ? 6 : 0) + '%' },
            }),
          ),
          h('span', { className: 'dshea-board-count' }, cell.count + ' · ' + cell.failed + ' ✗'),
        )
      const boardView = boardData
        ? h(
            'div',
            { className: 'dshea-board' },
            h(
              'button',
              { type: 'button', className: 'dshea-board-head', onClick: toggleBoard, title: COPY.boardHint },
              h('span', { className: 'dshea-board-caret' }, boardOpen ? '▾' : '▸'),
              h('span', { className: 'dshea-board-title' }, COPY.boardTitle),
              h(
                'span',
                { className: boardData.failed > 0 ? 'dshea-board-sum' : 'dshea-board-sum is-clean' },
                boardData.total + ' ' + COPY.boardUnit + ' · ' + boardData.failed + ' ' + COPY.boardFailedShort + ' · ' + boardData.rate + '%',
              ),
            ),
            boardOpen
              ? h(
                  'div',
                  { className: 'dshea-board-body' },
                  boardData.tags.length > 0 ? h('div', { className: 'dshea-board-group' }, COPY.boardTags) : null,
                  boardData.tags.map((cell) => boardRow(cell, 'tag')),
                  boardData.programs.length > 0 ? h('div', { className: 'dshea-board-group' }, COPY.boardPrograms) : null,
                  boardData.programs.map((cell) => boardRow(cell, 'program')),
                  boardData.tags.length === 0 && boardData.programs.length === 0
                    ? h('span', { className: 'dshea-board-empty' }, COPY.boardEmpty)
                    : null,
                )
              : null,
          )
        : null

      // Two switches an install can turn off without uninstalling: the end-of-turn
      // reminder and the injected lessons. Both persist in prefs, so they survive restarts.
      const prefs = (data && data.prefs) || {}
      const promptOn = prefs.prompt !== false
      const injectOn = prefs.inject !== false
      const switchButton = (label, on, next) =>
        h(
          'button',
          {
            type: 'button',
            className: on ? 'dshea-switch is-on' : 'dshea-switch',
            onClick: () => pushPrefs(next),
            title: COPY.memoryTip,
          },
          h('span', { className: 'dshea-switch-dot' }),
          label,
        )
      const memoryRow = h(
        'div',
        { className: 'dshea-memory' },
        h('span', { className: 'dshea-memory-title' }, COPY.memory),
        switchButton(COPY.memoryPrompt, promptOn, { prompt: !promptOn }),
        switchButton(COPY.memoryInject, injectOn, { inject: !injectOn }),
      )

      return h('div', { className: 'dshea-root' }, header, stylePanel, stage, trendRow, memoryRow, boardView, logStrip)
    }

    function statCell(label, value) {
      return h(
        'div',
        { className: 'dshea-stat' },
        h('span', { className: 'dshea-stat-value' }, value),
        h('span', { className: 'dshea-stat-label' }, label),
      )
    }

    function legendRow(color, label) {
      return h(
        'div',
        { className: 'dshea-legend-row' },
        h('span', { className: 'dshea-legend-dot', style: { background: color, boxShadow: '0 0 7px ' + color } }),
        h('span', null, label),
      )
    }

    function renderRetroCard(node, onClose, onOpen) {
      const retro = node.retro || {}
      const field = (label, value) =>
        value
          ? h(
              'div',
              { key: label, className: 'dshea-card-field' },
              h('span', { className: 'dshea-card-k' }, label),
              h('span', { className: 'dshea-card-v' }, String(value)),
            )
          : null
      const tools = Array.isArray(retro.tools) ? retro.tools.join(' · ') : ''
      const files = Array.isArray(retro.files)
        ? retro.files.map((path) => String(path).split(/[\\/]/).pop()).join(' · ')
        : ''
      return h(
        'div',
        { className: 'dshea-card' },
        h(
          'div',
          { className: 'dshea-card-head' },
          h('span', { className: 'dshea-card-kind', style: { color: KIND_CSS.retro } }, KIND_TEXT.retro),
          h('span', { className: 'dshea-card-name' }, retro.auto ? COPY.rAuto : COPY.rPicked),
          sessionIdOf(node)
            ? h('span', { className: 'dshea-card-act', role: 'button', onClick: () => onOpen(node), title: COPY.openSession }, COPY.openSession)
            : null,
          h('span', { className: 'dshea-card-close', onClick: onClose, role: 'button', title: COPY.close }, '✕'),
        ),
        h('div', { className: 'dshea-card-msg' }, node.label || ''),
        field(COPY.rDone, retro.done),
        field(COPY.rCause, retro.cause),
        field(COPY.rFix, retro.fix),
        field(COPY.rLesson, retro.lesson),
        field(COPY.rTools, tools),
        field(COPY.rFiles, files),
        field(
          COPY.rErrors,
          Array.isArray(node.linked) && node.linked.length
            ? fill(COPY.linkedCount, { n: node.linked.length }) + ' · ' + truncate(node.linked[0], 70)
            : '',
        ),
        node.recurred > 0
          ? h(
              'div',
              { key: 'recurred', className: 'dshea-card-field' },
              h('span', { className: 'dshea-card-k', style: { color: KIND_CSS.stale } }, COPY.recurred),
              h(
                'span',
                { className: 'dshea-card-v is-stale' },
                COPY.stale + ' · ' + fill(COPY.recurredDetail, { n: node.recurred, time: relTime(node.recurredAt) }),
              ),
            )
          : null,
        h(
          'div',
          { className: 'dshea-card-grid' },
          cardRow(COPY.lastSeen, relTime(retro.at || node.last) + ' · ' + clock(retro.at || node.last)),
          retro.turn ? cardRow(COPY.turn, '#' + retro.turn) : null,
          retro.sessionId ? cardRow(COPY.session, '…' + String(retro.sessionId).slice(-10)) : null,
        ),
      )
    }

    function renderCard(node, selectedId, onClose, onOpen, onIgnore) {
      if (node.kind === 'retro' && node.retro) return renderRetroCard(node, onClose, onOpen)
      const isHub = isHubNode(node.kind)
      const kindLabel = KIND_TEXT[node.kind] || 'ERROR'
      const rows = []
      rows.push(cardRow(COPY.count, '×' + fmtNumber(node.count || 0)))
      if (node.last) rows.push(cardRow(COPY.lastSeen, relTime(node.last) + ' · ' + clock(node.last)))
      if (node.first) rows.push(cardRow(COPY.firstSeen, clock(node.first)))
      if (node.sessionId) rows.push(cardRow(COPY.session, '…' + String(node.sessionId).slice(-10)))
      else if (Array.isArray(node.sessions) && node.sessions.length > 0) {
        rows.push(cardRow(COPY.session, node.sessions.map((id) => '…' + String(id).slice(-6)).join('  ')))
      }
      if (node.turn) rows.push(cardRow(COPY.turn, '#' + node.turn + (node.step ? ' · step ' + node.step : '')))

      return h(
        'div',
        { className: 'dshea-card' },
        h(
          'div',
          { className: 'dshea-card-head' },
          h('span', { className: 'dshea-card-kind', style: { color: KIND_CSS[node.kind] || '#fff' } }, kindLabel),
          h('span', { className: 'dshea-card-name' }, isHub ? node.name || node.label : node.name && node.name !== '-' ? node.name : COPY.errorTag),
          isHub
            ? null
            : h('span', { className: 'dshea-card-act is-quiet', role: 'button', onClick: () => onIgnore(node), title: COPY.ignore }, COPY.ignore),
          sessionIdOf(node)
            ? h('span', { className: 'dshea-card-act', role: 'button', onClick: () => onOpen(node), title: COPY.openSession }, COPY.openSession)
            : null,
          h('span', { className: 'dshea-card-close', onClick: onClose, role: 'button', title: COPY.close }, '✕'),
        ),
        isHub ? null : h('div', { className: 'dshea-card-msg' }, node.message || ''),
        h('div', { className: 'dshea-card-grid' }, rows),
      )
    }

    function cardRow(label, value) {
      return [h('span', { key: label + '-k', className: 'dshea-card-k' }, label), h('span', { key: label + '-v', className: 'dshea-card-v' }, value)]
    }

    // ─────────────────────────────────────────────────────────────────────────
    // error boundary: a panel bug must never take the host UI down with it
    // ─────────────────────────────────────────────────────────────────────────
    class AtlasBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        console.error('[error-atlas] panel render failed', error)
      }

      render() {
        if (this.state.error) {
          return h(
            'div',
            { className: 'dshea-root' },
            h(
              'div',
              { className: 'dshea-error' },
              COPY.panelCrash,
              h('div', { style: { marginTop: '6px', opacity: 0.6, fontSize: '10px' } }, String((this.state.error && this.state.error.message) || this.state.error)),
            ),
          )
        }
        return this.props.children
      }
    }

    function AtlasPanel() {
      return h(AtlasBoundary, null, h(ErrorAtlasPanel))
    }

    // ─────────────────────────────────────────────────────────────────────────
    // plugin half
    // ─────────────────────────────────────────────────────────────────────────
    // Session navigation
    // ─────────────────────────────────────────────────────────────────────────
    // `uiWorkspace` is a shipped client service, resolved at click time and never
    // declared in `inject`: a missing optional service must not keep this panel from
    // mounting, and the only thing lost without it is the jump.
    let services = null
    let localeService = null

    // Cordis guards service access: reading `ctx.locale` without declaring it in
    // `inject` throws ("cannot get property ... without inject"), and an optional
    // service must never be declared there or a missing one stops the whole plugin.
    // Every optional service is therefore read through this probe, once, inside a guard.
    function serviceOf(ctx, name) {
      if (!ctx) return null
      try {
        const value = ctx[name]
        return value || null
      } catch {
        return null
      }
    }

    function sessionIdOf(node) {
      if (!node) return null
      if (typeof node.sessionId === 'string' && node.sessionId) return node.sessionId
      if (Array.isArray(node.sessions)) {
        const id = node.sessions.find((value) => typeof value === 'string' && value)
        if (id) return id
      }
      if (node.retro && typeof node.retro.sessionId === 'string' && node.retro.sessionId) return node.retro.sessionId
      return null
    }

    function openAtlasSession(sessionId) {
      if (!sessionId) return false
      const workspace = serviceOf(services, 'uiWorkspace')
      if (!workspace || typeof workspace.openSession !== 'function') return false
      try {
        workspace.openSession(String(sessionId))
        return true
      } catch {
        return false
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    return {
      inject: ['slots'],
      apply(ctx) {
        services = ctx
        // Follow the DSH language setting. The locale service is optional: without it the
        // panel simply stays in the Chinese dictionary.
        try {
          const locale = serviceOf(ctx, 'locale')
          if (locale && typeof locale.register === 'function') {
            localeService = locale
            locale.register(NS, 'zh', ZH)
            locale.register(NS, 'en', EN)
            if (typeof locale.getLocale === 'function') {
              const snapshot = locale.getLocale()
              if (snapshot && typeof snapshot.active === 'string' && snapshot.active) activeLocale = snapshot.active.slice(0, 2)
            }
          }
        } catch {
          activeLocale = activeLocale || 'zh'
        }
        const releaseStyles = ensureStyles()

        const disposeSidebar = ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 30,
              label: () => COPY.nav,
            },
            AtlasIcon,
          ),
        )

        const disposeMain = ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
            },
            AtlasPanel,
          ),
        )

        ctx.effect(() => () => {
          if (typeof disposeSidebar === 'function') disposeSidebar()
          if (typeof disposeMain === 'function') disposeMain()
          releaseStyles()
        })
      },
    }
  },
})
