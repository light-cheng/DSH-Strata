// Strata composer dock (Web / Desktop). Sits beside dsh-mem0's globe in
// `conversation.composer.dock`: an 18px glyph of strata discs that plays once
// when a layer changes the context, plus a short label.
//
// Data comes from the read-only route GET dsh-strata/gui/status?session=…
// (lib/gui-routes.js). Colours follow the family: currentColor (black / white
// with the theme), light blue on success, red on failure.
window.__ModuleLoader__.load({
  id: '@lightcheng/dsh-strata',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useLayoutEffect, useRef, useState } = React

    const NS = 'dsh-strata.dock'
    const PKG = '@lightcheng/dsh-strata'
    const STATUS_PATH = 'dsh-strata/gui/status'
    const POLL_MS = 2000
    /** An event older than this when first seen is shown as text only, without animation. */
    const FRESH_MS = 15000
    /** How long the event label and the success colour stay after an animation. */
    const SHOW_MS = 8000
    const ERROR_MS = 10 * 60 * 1000

    const en = {
      idle: 'Strata',
      waiting: 'Strata ready',
      notActive: 'Strata not active',
      card: 'Card',
      fold: 'Fold',
      autoFold: 'Auto fold',
      official: 'Summary',
      stale: 'Stale context',
      error: 'Compaction failed',
      open: 'Open Strata Context',
    }
    const zh = {
      idle: 'Strata',
      waiting: 'Strata 待命',
      notActive: 'Strata 未接管',
      card: '切卡片',
      fold: '折叠',
      autoFold: '自动折叠',
      official: '官方摘要',
      stale: '清理旧上下文',
      error: '压缩失败',
      open: '打开 Strata Context',
    }

    // ---- glyph geometry (viewBox 0 0 32 32), same shape as icon.svg ----
    const DISCS = [
      { cy: 8.6, rx: 10.6, ry: 2.9, o: 0.3 },
      { cy: 13.7, rx: 7.8, ry: 2.2, o: 0.55 },
      { cy: 17.9, rx: 5.1, ry: 1.5, o: 0.8 },
      { cy: 21.1, rx: 2.7, ry: 0.9, o: 1 },
    ]
    const CORE = { cy: 24.8, r: 1.45 }
    const DURATION = { card: 900, fold: 1500 }
    const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
    const bump = (x, w) => Math.exp(-(x * x) / (w * w))

    /** Geometry of one frame. mode: idle | card (L1) | fold (L2 and L∞); t in [0, 1]. */
    function frame(mode, t) {
      const discs = DISCS.map((disc) => ({ ...disc }))
      const core = { ...CORE }
      let grain = null
      if (mode === 'card') {
        // L1: one grain drops into the top layer, which thickens briefly.
        const y = -1 + ease(Math.min(1, t / 0.6)) * (discs[0].cy + 1)
        grain = { y, o: t < 0.6 ? 1 : 0 }
        const k = t > 0.55 ? bump((t - 0.55) / 0.25, 1) : 0
        discs[0].ry *= 1 + 0.25 * k
        discs[0].o += 0.35 * k
      } else if (mode === 'fold') {
        // L2 / L∞: the grain sinks through every layer, each presses as it passes, the core pulses.
        const y = -1 + ease(t) * (CORE.cy + 1)
        grain = { y, o: t < 0.92 ? 1 : 0 }
        for (const disc of discs) {
          const k = bump(y - disc.cy, 2.2)
          disc.ry *= 1 - 0.38 * k
          disc.rx *= 1 + 0.07 * k
          disc.o = Math.min(1, disc.o + 0.3 * k)
        }
        core.r *= 1 + 0.45 * bump((t - 0.95) / 0.08, 1)
      }
      return { discs, core, grain }
    }

    function paint(refs, geometry) {
      geometry.discs.forEach((disc, index) => {
        const element = refs.discs[index]
        if (!element) return
        element.setAttribute('cy', disc.cy.toFixed(2))
        element.setAttribute('rx', disc.rx.toFixed(2))
        element.setAttribute('ry', disc.ry.toFixed(2))
        element.setAttribute('opacity', Math.min(1, disc.o).toFixed(2))
      })
      if (refs.core) refs.core.setAttribute('r', geometry.core.r.toFixed(2))
      if (refs.grain) {
        refs.grain.setAttribute('cy', (geometry.grain?.y ?? 0).toFixed(2))
        refs.grain.setAttribute('opacity', geometry.grain ? String(geometry.grain.o) : '0')
      }
    }

    function StrataGlyph({ state, mode, playKey }) {
      const refs = useRef({ discs: [], core: null, grain: null })
      useLayoutEffect(() => {
        paint(refs.current, frame('idle', 0))
        if (!playKey || mode === 'idle') return
        const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        if (reduced) return
        let start = 0
        let handle = 0
        const tick = (now) => {
          if (!start) start = now
          const t = (now - start) / DURATION[mode]
          if (t >= 1) {
            paint(refs.current, frame('idle', 0))
            return
          }
          paint(refs.current, frame(mode, t))
          handle = requestAnimationFrame(tick)
        }
        handle = requestAnimationFrame(tick)
        return () => cancelAnimationFrame(handle)
      }, [playKey, mode])

      const classes = ['strata-glyph']
      if (state === 'success') classes.push('is-success')
      if (state === 'error') classes.push('is-error')
      if (state === 'off') classes.push('is-off')
      return h(
        'svg',
        { className: classes.join(' '), viewBox: '0 0 32 32', width: 18, height: 18, 'aria-hidden': 'true' },
        h(
          'g',
          { fill: 'currentColor' },
          DISCS.map((disc, index) =>
            h('ellipse', {
              key: index,
              cx: 16,
              cy: disc.cy,
              rx: disc.rx,
              ry: disc.ry,
              opacity: disc.o,
              ref: (element) => {
                refs.current.discs[index] = element
              },
            }),
          ),
          h('circle', { cx: 16, cy: CORE.cy, r: CORE.r, ref: (element) => (refs.current.core = element) }),
          h('circle', { cx: 16, cy: 0, r: 1.15, opacity: 0, ref: (element) => (refs.current.grain = element) }),
        ),
      )
    }

    function kTokens(value) {
      if (!Number.isFinite(value)) return ''
      return value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(Math.round(value))
    }

    async function fetchStatus(sessionId, lang) {
      const url = new URL(`${STATUS_PATH}?session=${encodeURIComponent(sessionId)}${lang ? `&lang=${encodeURIComponent(lang)}` : ''}`, document.baseURI)
      const response = await fetch(url.toString(), { credentials: 'same-origin', headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    /** The active UI language id, sent with each poll so /strata answers in it. */
    function activeLanguage(ctx) {
      try {
        const active = ctx.locale?.getLocale?.()?.active
        return typeof active === 'string' ? active : active?.id || ''
      } catch {
        return ''
      }
    }

    const RANK = { ctx: 0, L1: 1, L2: 2, 'L∞': 3 }

    /**
     * Pick what to play from the events newer than `seenAt`. One turn-end
     * maintenance can land a fold, a card and a stale sweep between two polls;
     * playing only the last one hid the fold (joint test J6). The biggest layer
     * wins, then the larger reclaim; `at` is the newest event's, so the play
     * mark moves past all of them.
     */
    function pickEvent(events, seenAt) {
      const fresh = (events || []).filter((event) => event.at > seenAt)
      if (fresh.length === 0) return null
      const best = fresh.reduce((a, b) => {
        const ra = RANK[a.layer] ?? 0
        const rb = RANK[b.layer] ?? 0
        if (rb !== ra) return rb > ra ? b : a
        return (b.reclaimed || 0) > (a.reclaimed || 0) ? b : a
      })
      return { ...best, at: Math.max(...fresh.map((event) => event.at)) }
    }

    function eventLabel(t, event) {
      const saved = event.reclaimed ? ` −${kTokens(event.reclaimed)}` : ''
      if (event.layer === 'L1') return `${t('card')}${saved}`
      if (event.layer === 'L2') return `${t(event.auto ? 'autoFold' : 'fold')} T${event.tier || 1}${saved}`
      if (event.layer === 'ctx') return `${t('stale')}${saved}`
      return `${t('official')}${saved}`
    }

    function StrataDock({ ctx, t, sessionId }) {
      const [data, setData] = useState(null)
      const [failed, setFailed] = useState(false)
      const [play, setPlay] = useState({ key: 0, mode: 'idle', event: null, until: 0 })
      const seen = useRef(null)
      const [, setTick] = useState(0)

      useEffect(() => {
        seen.current = null
        if (!sessionId) return
        let live = true
        const load = async () => {
          try {
            const next = await fetchStatus(sessionId, activeLanguage(ctx))
            if (!live) return
            setData(next)
            setFailed(false)
            // The first poll only records where we are; old events do not replay.
            if (seen.current === null) {
              seen.current = next.events?.[next.events.length - 1]?.at ?? 0
              return
            }
            const latest = pickEvent(next.events, seen.current)
            if (latest) {
              seen.current = latest.at
              const fresh = (next.now ?? Date.now()) - latest.at < FRESH_MS
              setPlay((prev) => ({
                key: fresh ? prev.key + 1 : prev.key,
                mode: latest.layer === 'L1' || latest.layer === 'ctx' ? 'card' : 'fold',
                event: latest,
                until: Date.now() + SHOW_MS,
              }))
            }
          } catch {
            if (live) setFailed(true)
          }
        }
        void load()
        const timer = setInterval(() => {
          void load()
          setTick((value) => value + 1)
        }, POLL_MS)
        return () => {
          live = false
          clearInterval(timer)
        }
      }, [sessionId])

      let state = 'idle'
      let label = t('waiting')
      const now = Date.now()
      const usage = data?.usage
      if (usage && usage.window > 0) label = `${t('idle')} ${((usage.totalTokens / usage.window) * 100).toFixed(1)}%`
      if (data && data.takeover && data.takeover !== 'active' && data.takeover !== 'unknown') {
        state = 'off'
        label = t('notActive')
      } else if (failed || (data?.error && now - data.error.at < ERROR_MS)) {
        state = 'error'
        label = t('error')
      } else if (play.event && now < play.until) {
        state = 'success'
        label = eventLabel(t, play.event)
      }

      const open = () => {
        try {
          ctx.get('pluginNavigation')?.openBundle?.(PKG)
        } catch {
          // Navigation is optional.
        }
      }

      return h(
        'button',
        { type: 'button', className: 'strata-dock', title: t('open'), onClick: open },
        h(StrataGlyph, { state, mode: play.mode, playKey: play.key }),
        h('span', { className: 'strata-dock-text' }, label),
      )
    }

    const CSS = `
      .strata-dock{display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:1.5;padding:0 2px;cursor:pointer;white-space:nowrap;max-width:100%}
      .strata-dock:hover{color:var(--dsw-alias-label-secondary)}
      .strata-glyph{width:18px;height:18px;flex:none;color:var(--dsw-alias-label-primary);overflow:visible;transition:color .25s ease,filter .25s ease}
      .strata-glyph.is-success{color:#7dd3fc;filter:drop-shadow(0 0 2px color-mix(in srgb, #7dd3fc 65%, transparent))}
      .strata-glyph.is-error{color:var(--dsw-alias-state-error-primary)}
      .strata-glyph.is-off{color:var(--dsw-alias-label-tertiary)}
      .strata-dock-text{overflow:hidden;text-overflow:ellipsis}
    `

    // ---------------------------------------------------------------- settings page
    // Plugin page section (`plugins.bundle.config`): edits the strata-gate
    // row's Config (lib/config.js) through the host's config form. gate.js
    // publishes saved values to every Strata engine; STRATA_* environment
    // variables still win. Strings: en + zh, same keys.

    const SETTINGS_NS = 'dsh-strata.settings'
    const ENTRY_ID = 'strata-gate'
    const DEFAULTS = {
      mode: 'cost',
      autoFold: true,
      nudge: true,
      autoFoldPct: 50,
      autoFoldForcePct: 60,
      autoFoldTargetPct: 30,
      protectedTailPct: 10,
      midTurnFold: false,
      midTurnCurrent: false,
      archiveDir: '',
      archiveMaxMB: 1024,
      archiveKeepDays: 0,
    }
    const FIELDS = Object.keys(DEFAULTS)
    const NUMBERS = ['autoFoldPct', 'autoFoldForcePct', 'autoFoldTargetPct', 'protectedTailPct', 'archiveMaxMB', 'archiveKeepDays']

    const settingsEn = {
      title: 'Strata settings',
      subtitle: 'Saved changes apply at the next turn end or step, without a restart. STRATA_* environment variables win over this page. Read-only figures (window, archive size, official summary line) are in /strata detail.',
      mode: 'Mode',
      modeCost: 'Cost first',
      modeQuality: 'Quality first',
      modeCustom: 'Custom',
      modeCostHint: 'Default. Folds late and only at turn end: auto-fold line 50% after 2 unanswered reminders, force line 60%, target 30%, protected tail at most 10% of the window, no mid-turn digests. Fewer cache misses, more context carried.',
      modeQualityHint: 'Keeps the context small: auto-fold line 25%, force line 35%, target 15%, protected tail at most 10%, mid-turn digests on. More cache misses, sharper context.',
      modeCustomHint: 'Set the lines yourself below. Applies immediately.',
      modeApplies: 'Applies immediately (next turn end or step). On small windows the lines are lowered below DSH’s official summary line; /strata detail shows it.',
      advanced: 'Custom values',
      autoFoldPct: 'Auto-fold line (% of window)',
      autoFoldPctHint: 'At turn end above this, after 2 unanswered reminders, Strata digests the oldest work. Applies immediately.',
      autoFoldForcePct: 'Force line (% of window)',
      autoFoldForcePctHint: 'Above this it folds without waiting for reminders. Applies immediately.',
      autoFoldTargetPct: 'Target (% of the room after fixed overhead)',
      autoFoldTargetPctHint: 'Folds stop near this. Applies immediately.',
      protectedTailPct: 'Protected tail cap (% of window)',
      protectedTailPctHint: 'The newest tool rounds are never folded; this caps how much they may hold. 0 = no cap. Applies immediately.',
      midTurnFold: 'Mid-turn digests',
      midTurnFoldHint: 'Above the force line, digest earlier turns before a step instead of waiting for the turn end. Applies immediately.',
      midTurnCurrent: 'Fold the current turn too',
      midTurnCurrentHint: 'With mid-turn digests: also digest this turn’s finished tool rounds outside the protected tail. Applies immediately.',
      switches: 'Switches',
      autoFold: 'Automatic folds',
      autoFoldHint: 'When reminders go unanswered, Strata digests the oldest work itself (restorable). Off: only the model’s own folds and DSH’s official summary. Applies immediately.',
      nudge: 'Remind the model to fold',
      nudgeHint: 'Adds a short note when there is a lot to fold. Off: folding is left to automatic digests; the compress tool stays available. STRATA_NUDGE=off also turns it off. Applies immediately.',
      archive: 'Archive',
      archiveDir: 'Location',
      archiveDirHint: 'Empty = <DSH home>/strata. Applies to new sessions; open sessions keep their folder.',
      archiveDirPlaceholder: '<DSH home>/strata',
      archiveMaxMB: 'Size warning (MB)',
      archiveMaxMBHint: 'Warn in the log and /strata detail when all archives together exceed this. Nothing is deleted. 0 = never warn. Applies immediately.',
      archiveKeepDays: 'Delete archives of ended sessions after (days)',
      archiveKeepDaysHint: '0 = never (default). Above 0, archives of sessions unused for that long are deleted automatically; folds in those sessions then cannot be restored. /strata purge ended cleans up by hand. Applies immediately.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      discard: 'Discard changes',
      reset: 'Restore defaults',
      resetConfirm: 'Restore all defaults?',
      resetDone: 'Defaults restored',
      unsaved: 'Unsaved changes',
      saveFailed: 'Could not save; reload the page and try again.',
      invalidNumber: 'Enter whole numbers.',
      linesOrder: 'The force line must be at or above the auto-fold line, and the target below the auto-fold line.',
      readOnly: 'This profile’s configuration is read-only here.',
      loading: 'Loading…',
    }
    const settingsZh = {
      title: 'Strata 设置',
      subtitle: '保存后在下一次轮末或下一步生效，不用重启。环境变量（STRATA_*）优先于这里的设置。只读信息（窗口、存档大小、官方摘要触发线）见 /strata detail。',
      mode: '模式',
      modeCost: '成本优先',
      modeQuality: '质量优先',
      modeCustom: '自定义',
      modeCostHint: '默认。晚折叠、只在轮末折叠：自动折叠线 50%（连续 2 次提醒没有回应时），强制折叠线 60%，目标 30%，受保护末尾最多占窗口 10%，不做轮中摘要。缓存未命中少，带的上下文多。',
      modeQualityHint: '让上下文保持精简：自动折叠线 25%，强制折叠线 35%，目标 15%，受保护末尾最多 10%，开启轮中摘要。缓存未命中多一些，上下文更干净。',
      modeCustomHint: '在下面自己设置各条线。立即生效。',
      modeApplies: '立即生效（下一次轮末或下一步）。窗口较小时，各条线会自动降到 DSH 官方摘要触发线之下；/strata detail 里能看到。',
      advanced: '自定义数值（仅在自定义模式下生效）',
      autoFoldPct: '自动折叠线（占窗口 %）',
      autoFoldPctHint: '轮末超过这条线、且连续 2 次提醒没有回应时，Strata 从最早的内容开始折叠。立即生效。',
      autoFoldForcePct: '强制折叠线（占窗口 %）',
      autoFoldForcePctHint: '超过这条线时不等提醒，直接折叠。立即生效。',
      autoFoldTargetPct: '折叠目标（固定开销之外剩余空间的 %）',
      autoFoldTargetPctHint: '折叠到接近这个值就停。立即生效。',
      protectedTailPct: '受保护末尾上限（占窗口 %）',
      protectedTailPctHint: '最近几轮工具调用不会被折叠；这里限制它们最多占多少。0 = 不设上限。立即生效。',
      midTurnFold: '轮中摘要',
      midTurnFoldHint: '超过强制折叠线时，在下一步之前就摘要之前几轮，不等轮末。立即生效。',
      midTurnCurrent: '也折叠当前轮',
      midTurnCurrentHint: '开启轮中摘要时，也摘要本轮已完成、且不在受保护末尾里的工具轮次。立即生效。',
      switches: '开关',
      autoFold: '自动折叠',
      autoFoldHint: '提醒没有回应时，Strata 自己把最早的内容折成摘要（可还原）。关掉后只剩模型自己的折叠和 DSH 官方摘要。立即生效。',
      nudge: '提醒模型折叠',
      nudgeHint: '可折叠的内容多时给模型加一句提醒。关掉后只靠自动折叠；compress 工具仍可用。环境变量 STRATA_NUDGE=off 也能关掉。立即生效。',
      archive: '存档',
      archiveDir: '存档位置',
      archiveDirHint: '留空 = <DSH 主目录>/strata。对新会话生效；已打开的会话继续用原来的文件夹。',
      archiveDirPlaceholder: '<DSH 主目录>/strata',
      archiveMaxMB: '大小提醒上限（MB）',
      archiveMaxMBHint: '所有存档加起来超过这个值时，在日志和 /strata detail 里提醒。不会删除任何文件。0 = 不提醒。立即生效。',
      archiveKeepDays: '已结束会话的存档保留天数',
      archiveKeepDaysHint: '0 = 永不删除（默认）。大于 0 时，超过这么多天没用过的会话存档会被自动删除，之后这些会话里的折叠无法再还原。手动清理用 /strata purge ended。立即生效。',
      save: '保存',
      saving: '正在保存…',
      saved: '已保存',
      discard: '放弃更改',
      reset: '恢复默认',
      resetConfirm: '确定恢复全部默认设置？',
      resetDone: '已恢复默认',
      unsaved: '有未保存的更改',
      saveFailed: '保存失败，请刷新页面后重试。',
      invalidNumber: '请输入整数。',
      linesOrder: '强制折叠线不能低于自动折叠线，折叠目标要低于自动折叠线。',
      readOnly: '这个 profile 的配置在这里是只读的。',
      loading: '正在加载…',
    }

    function normalise(value) {
      const next = { ...DEFAULTS }
      for (const key of FIELDS) {
        if (value && value[key] !== undefined && value[key] !== null) next[key] = value[key]
      }
      if (!['cost', 'quality', 'custom'].includes(next.mode)) next.mode = 'cost'
      return next
    }

    /** Problems with a draft, or '' (numbers whole; force ≥ auto-fold > target). */
    function draftProblem(draft) {
      for (const key of NUMBERS) {
        const n = Number(draft[key])
        if (String(draft[key]).trim() === '' || !Number.isInteger(n) || n < 0) return 'invalidNumber'
      }
      if (draft.mode === 'custom') {
        const auto = Number(draft.autoFoldPct)
        const force = Number(draft.autoFoldForcePct)
        const target = Number(draft.autoFoldTargetPct)
        if (auto < 1 || force < 1 || target < 1 || auto > 95 || force > 95 || target > 95) return 'invalidNumber'
        if (force < auto || target >= auto) return 'linesOrder'
      }
      return ''
    }

    /** Ops that turn `initial` into `draft`: values equal to the default are unset, so later defaults follow. */
    function saveOps(draft, initial) {
      const ops = []
      for (const key of FIELDS) {
        const value = NUMBERS.includes(key) ? Number(draft[key]) : key === 'archiveDir' ? String(draft[key] || '').trim() : draft[key]
        const before = NUMBERS.includes(key) ? Number(initial[key]) : initial[key]
        if (value === before) continue
        ops.push(value === DEFAULTS[key] ? { op: 'unset', path: [key] } : { op: 'set', path: [key], value })
      }
      return ops
    }

    const resetOps = () => FIELDS.map((key) => ({ op: 'unset', path: [key] }))

    function SField({ label, hint, children }) {
      return h('label', { className: 'strata-field' }, h('span', { className: 'strata-label' }, label), children, hint ? h('span', { className: 'strata-hint' }, hint) : null)
    }

    function SToggle({ label, hint, checked, onChange, disabled }) {
      return h(
        'div',
        { className: 'strata-toggle-row' },
        h('div', { className: 'strata-toggle-copy' }, h('span', { className: 'strata-toggle-label' }, label), hint ? h('span', { className: 'strata-hint' }, hint) : null),
        h('button', { type: 'button', className: 'strata-toggle', role: 'switch', 'aria-checked': checked, 'aria-label': label, 'data-on': checked ? 'true' : 'false', disabled, onClick: () => onChange(!checked) }, h('span')),
      )
    }

    function SettingsPage({ ctx, t }) {
      const form = ctx.configForms.get(ENTRY_ID)
      const [snapshot, setSnapshot] = useState(() => form.getSnapshot())
      const [draft, setDraft] = useState(null)
      const [initial, setInitial] = useState(null)
      const [state, setState] = useState({ phase: 'idle', message: '' })
      const [confirmReset, setConfirmReset] = useState(false)

      useEffect(() => form.subscribe(() => setSnapshot(form.getSnapshot())), [form])
      useEffect(() => {
        if (snapshot.status !== 'ready') return
        const next = normalise(snapshot.value)
        // Follow outside changes while nothing is being edited.
        setInitial((current) => {
          if (!current || !draft || JSON.stringify(draft) === JSON.stringify(current)) setDraft(next)
          return next
        })
      }, [snapshot])

      if (!draft || !initial) return h('div', { className: 'strata-page' }, h('p', { className: 'strata-sub' }, t('loading')))

      const writable = snapshot.writable !== false
      const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
      const set = (key) => (value) => {
        setDraft({ ...draft, [key]: value })
        setState({ phase: 'idle', message: '' })
      }
      const problem = draftProblem(draft)

      const save = async () => {
        if (problem) {
          setState({ phase: 'error', message: t(problem) })
          return
        }
        const ops = saveOps(draft, initial)
        if (!ops.length) return
        setState({ phase: 'saving', message: '' })
        try {
          const accepted = await form.mutate(ops, snapshot.revision)
          setState(accepted ? { phase: 'saved', message: t('saved') } : { phase: 'error', message: t('saveFailed') })
          if (accepted) setInitial({ ...draft })
        } catch (error) {
          setState({ phase: 'error', message: error?.message || t('saveFailed') })
        }
      }

      const reset = async () => {
        if (!confirmReset) {
          setConfirmReset(true)
          return
        }
        setConfirmReset(false)
        setState({ phase: 'saving', message: '' })
        try {
          const accepted = await form.mutate(resetOps(), snapshot.revision)
          if (accepted) {
            setDraft({ ...DEFAULTS })
            setInitial({ ...DEFAULTS })
          }
          setState(accepted ? { phase: 'saved', message: t('resetDone') } : { phase: 'error', message: t('saveFailed') })
        } catch (error) {
          setState({ phase: 'error', message: error?.message || t('saveFailed') })
        }
      }

      const modes = [['cost', 'modeCost'], ['quality', 'modeQuality'], ['custom', 'modeCustom']]
      const modeHint = { cost: 'modeCostHint', quality: 'modeQualityHint', custom: 'modeCustomHint' }[draft.mode]
      const number = (key, extra = {}) =>
        h(SField, { label: t(key), hint: t(`${key}Hint`) }, h('input', { className: 'strata-input', type: 'number', min: 0, step: 1, value: draft[key], disabled: !writable, onChange: (event) => set(key)(event.target.value), ...extra }))

      return h(
        'div',
        { className: 'strata-page', 'data-strata-settings': true },
        h('div', null, h('h3', { className: 'strata-title' }, t('title')), h('p', { className: 'strata-sub' }, t('subtitle'))),
        h(
          'section',
          { className: 'strata-card strata-section' },
          h('h4', { className: 'strata-section-title' }, t('mode')),
          h(
            'div',
            { className: 'strata-segments', role: 'radiogroup', 'aria-label': t('mode') },
            modes.map(([value, key]) =>
              h('button', { key: value, type: 'button', role: 'radio', 'aria-checked': draft.mode === value, className: 'strata-segment', 'data-active': draft.mode === value ? 'true' : 'false', disabled: !writable, onClick: () => set('mode')(value) }, t(key)),
            ),
          ),
          h('p', { className: 'strata-hint' }, t(modeHint)),
          h('p', { className: 'strata-hint' }, t('modeApplies')),
          draft.mode === 'custom'
            ? h(
                'div',
                { className: 'strata-advanced' },
                h('h5', { className: 'strata-subtitle' }, t('advanced')),
                h('div', { className: 'strata-grid' }, number('autoFoldPct', { min: 1, max: 95 }), number('autoFoldForcePct', { min: 1, max: 95 }), number('autoFoldTargetPct', { min: 1, max: 95 }), number('protectedTailPct', { max: 50 })),
                h(SToggle, { label: t('midTurnFold'), hint: t('midTurnFoldHint'), checked: draft.midTurnFold === true, disabled: !writable, onChange: set('midTurnFold') }),
                h(SToggle, { label: t('midTurnCurrent'), hint: t('midTurnCurrentHint'), checked: draft.midTurnCurrent === true, disabled: !writable || draft.midTurnFold !== true, onChange: set('midTurnCurrent') }),
              )
            : null,
        ),
        h(
          'section',
          { className: 'strata-card strata-section' },
          h('h4', { className: 'strata-section-title' }, t('switches')),
          h(SToggle, { label: t('autoFold'), hint: t('autoFoldHint'), checked: draft.autoFold !== false, disabled: !writable, onChange: set('autoFold') }),
          h(SToggle, { label: t('nudge'), hint: t('nudgeHint'), checked: draft.nudge !== false, disabled: !writable, onChange: set('nudge') }),
        ),
        h(
          'section',
          { className: 'strata-card strata-section' },
          h('h4', { className: 'strata-section-title' }, t('archive')),
          h(SField, { label: t('archiveDir'), hint: t('archiveDirHint') }, h('input', { className: 'strata-input', type: 'text', value: draft.archiveDir, placeholder: t('archiveDirPlaceholder'), disabled: !writable, onChange: (event) => set('archiveDir')(event.target.value) })),
          h('div', { className: 'strata-grid' }, number('archiveMaxMB'), number('archiveKeepDays')),
        ),
        h(
          'div',
          { className: 'strata-actions' },
          h('button', { type: 'button', className: 'strata-primary', disabled: !writable || !dirty || state.phase === 'saving', onClick: () => void save() }, state.phase === 'saving' ? t('saving') : t('save')),
          dirty ? h('button', { type: 'button', className: 'strata-secondary', onClick: () => { setDraft({ ...initial }); setState({ phase: 'idle', message: '' }) } }, t('discard')) : null,
          h('button', { type: 'button', className: 'strata-secondary', disabled: !writable || state.phase === 'saving', onClick: () => void reset(), onBlur: () => setConfirmReset(false) }, confirmReset ? t('resetConfirm') : t('reset')),
          dirty ? h('span', { className: 'strata-note' }, t('unsaved')) : null,
          state.phase === 'saved' ? h('span', { className: 'strata-ok' }, state.message) : null,
          state.phase === 'error' ? h('span', { className: 'strata-error' }, state.message) : null,
        ),
        !writable ? h('p', { className: 'strata-error' }, t('readOnly')) : null,
      )
    }

    const SETTINGS_CSS = `
      .strata-page{display:flex;flex-direction:column;gap:14px;max-width:820px;padding:2px 0 18px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
      .strata-title{font-size:16px;font-weight:600;margin:0 0 4px}
      .strata-sub{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px}
      .strata-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px}
      .strata-section{display:flex;flex-direction:column;gap:10px}
      .strata-section-title{font-size:13px;font-weight:600;margin:0}
      .strata-subtitle{font-size:12px;font-weight:600;margin:4px 0 0;color:var(--dsw-alias-label-secondary)}
      .strata-advanced{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px}
      .strata-segments{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
      .strata-segment{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);padding:7px 8px;font:inherit;font-size:12px;cursor:pointer;text-align:center}
      .strata-segment:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .strata-segment[data-active="true"]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:600}
      .strata-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px}
      .strata-field{display:flex;flex-direction:column;gap:4px;min-width:0}
      .strata-label{font-size:12px;color:var(--dsw-alias-label-secondary);font-weight:500}
      .strata-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:7px 9px;font:inherit;font-size:12px;outline:none}
      .strata-input:focus{border-color:var(--dsw-focus-ring-color);box-shadow:0 0 0 2px var(--dsw-focus-ring-color)}
      .strata-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:0}
      .strata-toggle-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
      .strata-toggle-copy{display:flex;flex-direction:column;gap:1px;min-width:0}
      .strata-toggle-label{font-size:12px;font-weight:500}
      .strata-toggle{position:relative;flex:0 0 auto;width:34px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-3);padding:0;cursor:pointer}
      .strata-toggle span{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:left .12s}
      .strata-toggle[data-on="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
      .strata-toggle[data-on="true"] span{left:16px;background:var(--dsw-alias-label-primary-foreground)}
      .strata-toggle:disabled{opacity:.5;cursor:default}
      .strata-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .strata-primary,.strata-secondary{border-radius:8px;padding:7px 14px;font:inherit;font-size:12px;font-weight:500;cursor:pointer;border:1px solid transparent}
      .strata-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
      .strata-secondary{background:transparent;color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}
      .strata-primary:disabled,.strata-secondary:disabled{opacity:.5;cursor:default}
      .strata-note{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:auto}
      .strata-ok{color:var(--dsw-alias-state-success-primary);font-size:12px}
      .strata-error{color:var(--dsw-alias-label-error);font-size:12px;margin:0}
    `

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-strata: dock dictionaries')
      ctx.effect(() => {
        const tagId = 'dsh-strata/dock.css'
        if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-strata'
        tag.dataset.pluginCss = tagId
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      }, 'dsh-strata: dock styles')
      // Settings page: only where the host offers config forms, so the dock
      // keeps working on hosts without them.
      ctx.effect(() => ctx.locale.register(SETTINGS_NS, { en: settingsEn, zh: settingsZh }), 'dsh-strata: settings dictionaries')
      ctx.effect(() => {
        const tagId = 'dsh-strata/settings.css'
        if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-strata'
        tag.dataset.pluginCss = tagId
        tag.textContent = SETTINGS_CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      }, 'dsh-strata: settings styles')
      const ts = ctx.locale.bind(SETTINGS_NS)
      ctx.inject(['configForms'], (child) => {
        child.slots.inject('plugins.bundle.config', () =>
          child.slots.register(
            { name: 'plugins.bundle.config', key: PKG, locale: SETTINGS_NS },
            () => h(SettingsPage, { ctx: child, t: ts }),
          ),
        )
      })
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'dsh-strata-status', order: -0.5, locale: NS },
          (props) => h(StrataDock, { ctx, t, sessionId: props?.sessionId }),
        ),
      )
    }

    return { inject: ['slots', 'locale'], apply, __test: { pickEvent, eventLabel, settingsEn, settingsZh, normalise, draftProblem, saveOps, resetOps, DEFAULTS } }
  },
})
