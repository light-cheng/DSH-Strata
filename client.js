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
      official: 'Summary',
      error: 'Compaction failed',
      open: 'Open Strata Context',
    }
    const zh = {
      idle: 'Strata',
      waiting: 'Strata 待命',
      notActive: 'Strata 未接管',
      card: '切卡片',
      fold: '折叠',
      official: '官方摘要',
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

    async function fetchStatus(sessionId) {
      const url = new URL(`${STATUS_PATH}?session=${encodeURIComponent(sessionId)}`, document.baseURI)
      const response = await fetch(url.toString(), { credentials: 'same-origin', headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    function eventLabel(t, event) {
      const saved = event.reclaimed ? ` −${kTokens(event.reclaimed)}` : ''
      if (event.layer === 'L1') return `${t('card')}${saved}`
      if (event.layer === 'L2') return `${t('fold')} T${event.tier || 1}${saved}`
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
            const next = await fetchStatus(sessionId)
            if (!live) return
            setData(next)
            setFailed(false)
            const latest = next.events?.[next.events.length - 1]
            // The first poll only records where we are; old events do not replay.
            if (seen.current === null) {
              seen.current = latest?.at ?? 0
              return
            }
            if (latest && latest.at > seen.current) {
              seen.current = latest.at
              const fresh = (next.now ?? Date.now()) - latest.at < FRESH_MS
              setPlay((prev) => ({
                key: fresh ? prev.key + 1 : prev.key,
                mode: latest.layer === 'L1' ? 'card' : 'fold',
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
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'dsh-strata-status', order: -0.5, locale: NS },
          (props) => h(StrataDock, { ctx, t, sessionId: props?.sessionId }),
        ),
      )
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
