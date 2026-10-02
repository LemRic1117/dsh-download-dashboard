/**
 * Client half of the download dashboard.
 *
 * Renders a floating monitor into the frame-wide `shell.overlay` seat and keeps
 * it fed from the Host half's read-only route. Placement is pure CSS anchored
 * to the frame box, so a window resize re-lays it out without any JavaScript;
 * the only scripted value is the right-hand offset, recomputed when the frame's
 * own geometry changes (window resize, sidebar or right panel opening).
 */
window.__ModuleLoader__.load({
  id: 'dsh-download-dashboard',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Host route served by this bundle's host half. */
    const ROUTE = '/dsh-downloads/state'
    /** Only downloads at least this large are worth a floating window. */
    const MIN_BYTES = 300 * 1024 * 1024
    /** A finished row lingers this long, then leaves the panel. */
    const LINGER_MS = 5 * 60 * 1000
    /**
     * An entry that still claims to run but has not been rewritten for this long
     * counts as interrupted: a killed or crashed downloader leaves its last
     * snapshot behind, and that record must not pose as live progress. A record
     * that resumes simply goes back to looking live.
     */
    const ACTIVE_STALE_MS = 90 * 1000
    /** Poll cadence: fast while something is running, slow while idle. */
    const POLL_ACTIVE_MS = 1500
    const POLL_IDLE_MS = 6000
    /** Consecutive failures before the panel admits it cannot reach the Host. */
    const FAILURES_BEFORE_NOTICE = 3
    /** Gap between the panel and the frame's right edge. */
    const GAP_PX = 12
    /** localStorage key holding the collapsed preference. */
    const COLLAPSED_KEY = 'dsh-download-dashboard:collapsed'

    const ACTIVE = ['starting', 'running', 'retrying']

    /**
     * Format a byte count for humans.
     * @param value - bytes, or null when unknown.
     * @returns the formatted size.
     */
    function fmtBytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '未知'
      if (value >= 1024 * 1024 * 1024) return (value / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
      if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MB'
      if (value >= 1024) return (value / 1024).toFixed(0) + ' KB'
      return value + ' B'
    }

    /**
     * Format a transfer rate.
     * @param value - bytes per second.
     * @returns the formatted rate.
     */
    function fmtSpeed(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '--'
      return fmtBytes(value) + '/s'
    }

    /**
     * Format a remaining time.
     * @param seconds - remaining seconds, or null when unknown.
     * @returns the formatted duration.
     */
    function fmtEta(seconds) {
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '--'
      const total = Math.round(seconds)
      const minutes = Math.floor(total / 60)
      const rest = total % 60
      if (minutes >= 60) return Math.floor(minutes / 60) + ':' + String(minutes % 60).padStart(2, '0') + ':' + String(rest).padStart(2, '0')
      return minutes + ':' + String(rest).padStart(2, '0')
    }

    /**
     * Completion percentage of one entry.
     * @param entry - a download entry.
     * @returns 0-100, or null when the total size is unknown.
     */
    function percentOf(entry) {
      const total = entry.totalBytes
      const done = entry.doneBytes
      if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null
      if (typeof done !== 'number' || !Number.isFinite(done)) return 0
      return Math.max(0, Math.min(100, Math.floor((done / total) * 100)))
    }

    /**
     * Whether an entry belongs in the panel.
     * @param entry - a download entry.
     * @param now - current epoch milliseconds.
     * @returns whether to show it.
     */
    /**
     * Age of a record, or Infinity when its timestamp cannot be read.
     * @param entry - a download entry.
     * @param now - current epoch milliseconds.
     * @returns age in milliseconds.
     */
    function ageOf(entry, now) {
      const updated = Date.parse(String((entry && entry.updatedAt) || ''))
      return Number.isFinite(updated) ? now - updated : Number.POSITIVE_INFINITY
    }

    /**
     * The status to render. A record that still claims to run but has gone quiet
     * is reported as interrupted, because its writer may have been killed.
     * @param entry - a download entry.
     * @param now - current epoch milliseconds.
     * @returns the status to show.
     */
    function shownStatus(entry, now) {
      const status = String((entry && entry.status) || '')
      if (ACTIVE.indexOf(status) < 0) return status
      return ageOf(entry, now) > ACTIVE_STALE_MS ? 'interrupted' : status
    }

    function isVisible(entry, now) {
      if (!entry || typeof entry !== 'object') return false
      const age = ageOf(entry, now)
      const live = ACTIVE.indexOf(String(entry.status || '')) >= 0 && age <= ACTIVE_STALE_MS
      if (!live) {
        // Finished, failed or abandoned: the linger clock runs from its last write.
        // An unreadable timestamp counts as expired, so a truncated record can
        // never become a row that no cleanup path removes.
        if (!(age <= LINGER_MS)) return false
      }
      const total = entry.totalBytes
      if (typeof total === 'number' && Number.isFinite(total)) return total >= MIN_BYTES
      // A chunked response reports no length; only an in-flight one can still turn out large.
      return live
    }

    /**
     * Rank an entry so running work sorts above finished work.
     * @param entry - a download entry.
     * @returns the sort rank.
     */
    function rankOf(entry) {
      const status = String((entry && entry.status) || '')
      if (ACTIVE.indexOf(status) >= 0) return 0
      if (status === 'failed') return 1
      return 2
    }

    const STYLE_ID = 'dsh-download-dashboard-style'
    const CSS = `
.ddw-root{max-width:calc(100% - var(--ddw-right,${GAP_PX}px) - ${GAP_PX}px);font-family:var(--dsw-font-family);}
.ddw-card{pointer-events:auto;box-sizing:border-box;display:flex;flex-direction:column;width:302px;max-width:100%;max-height:min(420px,calc(100vh - 160px));background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-elevation-panel);overflow:hidden;}
.ddw-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);}
.ddw-headText{flex:1;min-width:0;display:flex;align-items:baseline;gap:6px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;}
.ddw-count{color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums;}
.ddw-icon{pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:none;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;line-height:1;}
.ddw-icon:hover{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);}
.ddw-list{overflow-y:auto;overscroll-behavior:contain;}
.ddw-row{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2);}
.ddw-row:last-child{border-bottom:none;}
.ddw-rowTop{display:flex;align-items:center;gap:6px;min-width:0;}
.ddw-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);}
.ddw-dot[data-status="running"],.ddw-dot[data-status="retrying"],.ddw-dot[data-status="starting"]{background:var(--dsw-alias-brand-primary);}
.ddw-dot[data-status="done"]{background:var(--dsw-alias-state-success-primary);}
.ddw-dot[data-status="failed"]{background:var(--dsw-alias-state-error-primary);}
.ddw-dot[data-status="interrupted"]{background:var(--dsw-alias-state-warn-primary);}
.ddw-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;}
.ddw-pct{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;font-variant-numeric:tabular-nums;}
.ddw-track{height:4px;border-radius:2px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);overflow:hidden;}
.ddw-fill{height:100%;border-radius:2px;background:var(--dsw-alias-brand-primary);transition:width var(--ds-transition-duration) var(--ds-ease-in-out);}
.ddw-fill[data-status="done"]{background:var(--dsw-alias-state-success-primary);}
.ddw-fill[data-status="failed"]{background:var(--dsw-alias-state-error-primary);}
.ddw-fill[data-status="interrupted"]{background:var(--dsw-alias-state-warn-primary);}
.ddw-meta{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}
.ddw-sep{color:var(--dsw-alias-border-l2);}
.ddw-pill{pointer-events:auto;display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;cursor:pointer;font-family:inherit;font-variant-numeric:tabular-nums;}
.ddw-pill:hover{background:var(--dsw-alias-bg-layer-2);}
.ddw-warn{pointer-events:auto;max-width:302px;padding:6px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;}
`

    /**
     * How much of the frame the right panel currently occupies.
     *
     * The frame's own resolved grid tracks are the authority. The right column
     * carries `data-rightbar-col` as a published fallback for the case where
     * the track list cannot be parsed. Both are read defensively: placement
     * must never be the reason this entry throws, because a throwing entry in a
     * list seat is removed for the rest of the session.
     * @param frame - the frame element.
     * @returns the occupied width in px, 0 when unknown.
     */
    function rightbarWidth(frame) {
      try {
        const tracks = String(getComputedStyle(frame).gridTemplateColumns || '').split(' ').filter(Boolean)
        const last = parseFloat(tracks[tracks.length - 1])
        if (tracks.length >= 3 && Number.isFinite(last) && last > 1) return last
      } catch (error) {
        /* fall through to the published attribute */
      }
      try {
        const column = frame.querySelector('[data-rightbar-col]')
        if (column) {
          const box = column.getBoundingClientRect()
          const width = box && Number.isFinite(box.width) ? box.width : 0
          if (width > 1) return width
        }
      } catch (error) {
        /* placement falls back to the frame edge */
      }
      return 0
    }

    /**
     * Keep the panel's right offset in step with the frame geometry.
     *
     * The overlay layer is absolutely positioned inside the frame, so the card
     * follows every resize through layout alone; no position is computed from
     * scroll offsets or timer ticks. The one value CSS cannot know is how much
     * of the frame the right panel currently occupies.
     * @param node - the panel's own root element.
     * @returns a disposer removing every observer.
     */
    function trackFrame(node) {
      try {
        let frame = null
        let probe = node.parentElement
        for (let depth = 0; depth < 4 && probe; depth += 1, probe = probe.parentElement) {
          try {
            const tracks = String(getComputedStyle(probe).gridTemplateColumns || '')
            if (tracks && tracks !== 'none' && tracks.split(' ').filter(Boolean).length >= 3) {
              frame = probe
              break
            }
          } catch (error) {
            /* keep walking up */
          }
        }
        if (!frame) return () => {}
        const apply = () => {
          try {
            const occupied = rightbarWidth(frame)
            node.style.setProperty('--ddw-right', (occupied > 1 ? occupied + GAP_PX : GAP_PX) + 'px')
          } catch (error) {
            node.style.setProperty('--ddw-right', GAP_PX + 'px')
          }
        }
        apply()
        const cleanups = []
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(apply)
          observer.observe(frame)
          cleanups.push(() => observer.disconnect())
        }
        if (typeof MutationObserver === 'function') {
          const observer = new MutationObserver(apply)
          observer.observe(frame, {
            attributes: true,
            attributeFilter: ['style', 'data-rightbar-collapsed', 'data-rightbar-fullscreen', 'data-sidebar-collapsed'],
          })
          cleanups.push(() => observer.disconnect())
        }
        window.addEventListener('resize', apply)
        cleanups.push(() => window.removeEventListener('resize', apply))
        return () => {
          for (const dispose of cleanups) {
            try {
              dispose()
            } catch (error) {
              /* disposal must not throw either */
            }
          }
        }
      } catch (error) {
        return () => {}
      }
    }

    /**
     * The floating monitor.
     * @param props - unused in the seat; `initialDownloads` exists so the panel
     *   can be rendered with a fixed list outside the app (tests, previews).
     * @returns the overlay seat's content.
     */
    function DownloadDashboard(props) {
      const seeded = (props && props.initialDownloads) || null
      const rootRef = React.useRef(null)
      const latestRef = React.useRef(seeded || [])
      const [downloads, setDownloads] = React.useState(seeded || [])
      const [failures, setFailures] = React.useState(0)
      const [collapsed, setCollapsed] = React.useState(() => {
        try {
          return typeof window === 'undefined' ? false : window.localStorage.getItem(COLLAPSED_KEY) === '1'
        } catch (error) {
          return false
        }
      })

      // Placement follows the frame, not a scroll or timer tick.
      React.useEffect(() => {
        if (!rootRef.current) return undefined
        return trackFrame(rootRef.current)
      }, [])

      // One self-rescheduling poll: fast while work is running, slow while idle,
      // paused entirely while the page is hidden. A seeded panel does not poll.
      React.useEffect(() => {
        if (seeded) return undefined
        let alive = true
        let timer = null
        // Bumped whenever a new chain starts. A chain parked inside `await fetch`
        // when the page was hidden would otherwise resume and schedule a second
        // chain beside the fresh one, and `timer` could only cancel the newest.
        let generation = 0
        const schedule = (delay, mine) => {
          timer = window.setTimeout(() => {
            void tick(mine)
          }, delay)
        }
        const tick = async (mine) => {
          if (!alive || mine !== generation) return
          let next = POLL_IDLE_MS
          if (document.visibilityState === 'visible') {
            try {
              const response = await fetch(ROUTE, { cache: 'no-store', headers: { accept: 'application/json' } })
              if (!response.ok) throw new Error('HTTP ' + response.status)
              const payload = await response.json()
              if (!alive || mine !== generation) return
              const list = Array.isArray(payload && payload.downloads) ? payload.downloads : []
              latestRef.current = list
              setDownloads(list)
              setFailures(0)
            } catch (error) {
              if (!alive || mine !== generation) return
              setFailures((count) => count + 1)
            }
            const now = Date.now()
            next = latestRef.current.some((entry) => isVisible(entry, now) && ACTIVE.indexOf(String(entry.status)) >= 0)
              ? POLL_ACTIVE_MS
              : POLL_IDLE_MS
          }
          if (alive && mine === generation) schedule(next, mine)
        }
        generation += 1
        void tick(generation)
        const onVisible = () => {
          if (document.visibilityState === 'visible' && alive) {
            window.clearTimeout(timer)
            generation += 1
            void tick(generation)
          }
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          alive = false
          window.clearTimeout(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [])

      const toggle = React.useCallback(() => {
        setCollapsed((value) => {
          const next = !value
          try {
            window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
          } catch (error) {
            /* a blocked storage only costs the preference */
          }
          return next
        })
      }, [])

      // `downloads` gets a fresh array on every poll, so this re-filters whenever
      // new data arrives; reading the clock inside keeps the memo's inputs honest.
      const visible = React.useMemo(() => {
        const at = Date.now()
        return downloads
          .filter((entry) => isVisible(entry, at))
          .sort((a, b) => rankOf(a) - rankOf(b) || (Number(b.totalBytes) || 0) - (Number(a.totalBytes) || 0))
      }, [downloads])

      let body = null
      if (visible.length === 0) {
        body = failures >= FAILURES_BEFORE_NOTICE
          ? h('div', { className: 'ddw-warn' }, '下载监视：连不上宿主路由 ' + ROUTE)
          : null
      } else if (collapsed) {
        body = h(
          'button',
          { type: 'button', className: 'ddw-pill', onClick: toggle, title: '展开下载监视' },
          '↓ ' + visible.length + ' 个下载',
        )
      } else {
        const at = Date.now()
        const rows = visible.map((entry) => {
          const status = shownStatus(entry, at)
          const percent = percentOf(entry)
          const name = String(entry.name || entry.url || '下载')
          const meta = []
          if (status === 'done') {
            meta.push('已完成', fmtBytes(entry.totalBytes))
          } else if (status === 'failed') {
            meta.push('失败', String(entry.error || '未知原因'))
          } else if (status === 'interrupted') {
            meta.push('已中断', fmtBytes(entry.doneBytes) + (typeof entry.totalBytes === 'number' ? ' / ' + fmtBytes(entry.totalBytes) : ''))
          } else {
            meta.push(fmtBytes(entry.doneBytes) + (typeof entry.totalBytes === 'number' ? ' / ' + fmtBytes(entry.totalBytes) : ' / 大小未知'))
            meta.push(fmtSpeed(entry.speedBps))
            meta.push('剩 ' + fmtEta(entry.etaSec))
          }
          return h(
            'div',
            { className: 'ddw-row', key: String(entry.id || name) },
            h(
              'div',
              { className: 'ddw-rowTop' },
              h('span', { className: 'ddw-dot', 'data-status': status }),
              h('span', { className: 'ddw-name', title: String(entry.out || name) }, name),
              h('span', { className: 'ddw-pct' }, percent === null ? '--' : percent + '%'),
            ),
            h(
              'div',
              { className: 'ddw-track' },
              h('div', {
                className: 'ddw-fill',
                'data-status': status,
                style: { width: (percent === null ? (status === 'done' ? 100 : 8) : Math.max(percent, 2)) + '%' },
              }),
            ),
            h(
              'div',
              { className: 'ddw-meta', title: String(entry.out || '') },
              meta.map((part, index) =>
                index === 0 ? part : h(React.Fragment, { key: index }, h('span', { className: 'ddw-sep' }, '·'), part),
              ),
            ),
          )
        })
        body = h(
          'div',
          { className: 'ddw-card' },
          h(
            'div',
            { className: 'ddw-head' },
            h(
              'span',
              { className: 'ddw-headText' },
              '下载监视',
              h('span', { className: 'ddw-count' }, '≥300 MB · ' + visible.length),
            ),
            h('button', { type: 'button', className: 'ddw-icon', onClick: toggle, title: '收起' }, '–'),
          ),
          h('div', { className: 'ddw-list' }, rows),
        )
      }

      return h(
        'div',
        {
          className: 'ddw-root',
          ref: rootRef,
          // Inline on purpose: the overlay layer declares `pointer-events: auto`
          // on its direct children, and this root is one of them. The panel must
          // stay click-through everywhere except the card itself, and the anchor
          // box must stay small — the layer is frame-wide, so a full-bleed root
          // would swallow every click in the app.
          style: {
            position: 'absolute',
            top: '72px',
            right: 'var(--ddw-right, ' + GAP_PX + 'px)',
            pointerEvents: 'none',
            zIndex: 1,
          },
        },
        h('style', { id: STYLE_ID }, CSS),
        body,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-download-dashboard', order: 40 },
            DownloadDashboard,
          ),
        )
      },
    }
  },
})
