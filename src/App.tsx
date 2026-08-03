import { useEffect, useMemo, useRef, useState } from 'react'
import GridMap from './components/GridMap'
import SearchBox from './components/SearchBox'
import TimeSlider from './components/TimeSlider'
import type { SearchTarget } from './components/SearchBox'
import Sidebar from './components/Sidebar'
import MixStrip from './components/MixStrip'
import type { HistoryState, MixRange } from './components/MixStrip'
import { useGridData } from './hooks/useGridData'
import { useLiveData } from './hooks/useLiveData'
import { buildWeekScrub, loadHistory } from './lib/history'
import type { HistoryFile } from './lib/history'
import ComparePanel from './components/ComparePanel'
import {
  COUNTRIES,
  countryFromHash,
  DEFAULT_COUNTRY,
  hashFor,
  isCompareHash,
  stationFromHash,
} from './lib/countries'
import type { CountryId } from './lib/countries'
import { track } from './lib/analytics'
import { allGroupIds, computeStats, totalsFor } from './lib/filter'
import { isBaked, mixTitleFor } from './lib/sources'
import { computeMixRows, fleetCapacity, interconnectorCapacity } from './lib/fleet'
import { fmtCount, fmtGW } from './lib/format'
import type { GroupId, NetworkToggles } from './lib/types'
import './App.css'

const DEFAULT_TILES = import.meta.env.VITE_DEFAULT_TILES === '1'
/**
 * The one true phone/desktop breakpoint (#13, #55): **760px**, matching the
 * `@media (max-width: 760px)` blocks in App.css that float the sidebar over
 * the map. Three values used to disagree, so 640–760px wide got an
 * overlaying sidebar with no scrim and no Escape. The `.01` makes this the
 * exact complement of those CSS queries — a fractional viewport width can't
 * be "phone" to the stylesheet and "desktop" to this module.
 */
const DESKTOP_MQ = '(min-width: 760.01px)'

/**
 * Live media-query match. The drawer's dialog semantics and focus trap have
 * to follow the layout, so a mount-time snapshot isn't enough (#12).
 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setMatches(mq.matches)
    onChange() // the query may have changed between mount and effect
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

export default function App() {
  const [countryId, setCountryId] = useState<CountryId>(countryFromHash)
  // Compare view (#95): a pseudo-route over the map, shareable as #compare.
  const [compareOpen, setCompareOpen] = useState(() => isCompareHash(window.location.hash))
  const country = COUNTRIES[countryId]
  const { data, error, failures, total, retry } = useGridData(countryId)
  const { status: liveStatus, live, bmuMap } = useLiveData(country)
  const [enabled, setEnabled] = useState<Set<GroupId>>(allGroupIds)
  const [network, setNetwork] = useState<NetworkToggles>({
    t1: true,
    t2: true,
    t3: true,
    hvdc: true,
    construction: true,
  })
  const [tiles, setTiles] = useState(DEFAULT_TILES)
  const [liveMode, setLiveMode] = useState(true)
  // Phones get the map first; the burger opens the legend over a scrim (#13).
  const [sidebarOpen, setSidebarOpen] = useState(() => window.matchMedia(DESKTOP_MQ).matches)
  const isDesktop = useMediaQuery(DESKTOP_MQ)
  const burgerRef = useRef<HTMLButtonElement>(null)
  /**
   * Narrow viewports only (#12): the sidebar is a permanent side panel on
   * desktop, so it gets dialog semantics, a focus trap and a scrim strictly
   * while it floats over the map.
   */
  const sidebarAsDialog = sidebarOpen && !isDesktop
  const closeSidebar = () => {
    setSidebarOpen(false)
    setResizeSignal((n) => n + 1)
  }
  // The mix panel crowds small screens — start it collapsed on phones.
  const [mixOpen, setMixOpen] = useState(() => window.matchMedia(DESKTOP_MQ).matches)
  const [resizeSignal, setResizeSignal] = useState(0)
  const [searchTarget, setSearchTarget] = useState<SearchTarget | null>(null)
  // Metered-day scrub (#17): null = live/day-average as before.
  const [timeIndex, setTimeIndex] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  // Mix history (#64): week/month views load their baked file lazily. The
  // in-flight country lives in a ref — state alone would re-run the effect
  // and its cleanup would mark the fetch stale before it ever resolved.
  const [mixRange, setMixRange] = useState<MixRange>('day')
  const [history, setHistory] = useState<HistoryFile | null>(null)
  const [historyState, setHistoryState] = useState<HistoryState>('idle')
  const historyReq = useRef<CountryId | null>(null)

  useEffect(() => {
    // Country switch: back to the day view, drop the old country's history.
    historyReq.current = null
    setMixRange('day')
    setHistory(null)
    setHistoryState('idle')
  }, [countryId])

  useEffect(() => {
    if (mixRange === 'day' || historyState !== 'idle' || historyReq.current === countryId) return
    historyReq.current = countryId
    setHistoryState('loading')
    loadHistory(countryId).then((h) => {
      if (historyReq.current !== countryId) return // switched away meanwhile
      setHistory(h)
      setHistoryState(h ? 'ready' : 'missing')
    })
  }, [mixRange, historyState, countryId])

  // Range flips re-scope the slider (day ↔ week lengths differ) (#65).
  useEffect(() => {
    setTimeIndex(null)
    setPlaying(false)
  }, [mixRange])

  // Week scrub (#65): stitched per-station/link/mix series for the slider.
  const weekScrub = useMemo(
    () => (mixRange === 'week' && history ? buildWeekScrub(history.hourly) : null),
    [mixRange, history],
  )
  // Country switcher scroll affordance: fade the clipped edge(s).
  const switchRef = useRef<HTMLDivElement>(null)
  // Windows renders no flag emoji: 🇬🇧 falls back to the two regional-indicator
  // letters, so every chip read "GB GB". Detect once — a real flag ligates the
  // pair into one glyph, so its width is far less than the two letters apart.
  const flagsRender = useMemo(() => {
    try {
      const ctx = document.createElement('canvas').getContext('2d')
      if (!ctx) return true
      ctx.font = '16px sans-serif'
      const pair = ctx.measureText('🇬🇧').width
      const single = ctx.measureText('🇬').width
      return pair < single * 1.8
    } catch {
      return true
    }
  }, [])
  const [switchFades, setSwitchFades] = useState({ l: false, r: false })
  // The boot screen renders before data arrives, so the switcher isn't in
  // the DOM on first mount — both effects below must re-run once it is.
  const booted = Boolean(data)

  useEffect(() => {
    const el = switchRef.current
    if (!el) return
    const update = () => {
      const l = el.scrollLeft > 2
      const r = el.scrollLeft < el.scrollWidth - el.clientWidth - 2
      setSwitchFades((prev) => (prev.l === l && prev.r === r ? prev : { l, r }))
      // On monitors wide enough to fit every chip, the "show all" sheet is
      // pure duplication — it only earns its place when the strip overflows.
      setSwitchOverflow(el.scrollWidth > el.clientWidth + 4)
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    // Flag-emoji font loading reflows chip widths after mount.
    document.fonts?.ready.then(update)
    return () => {
      el.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [booted])

  // Keep the active chip in view — 21 grids no longer fit most widths.
  useEffect(() => {
    const scrollToActive = () => {
      const btn = switchRef.current?.querySelector('.country-btn--on')
      if (!btn) return
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      btn.scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block: 'nearest',
        inline: 'nearest',
      })
    }
    scrollToActive()
    // Re-run once fonts land: emoji load can shift the chip off-screen again.
    let stale = false
    document.fonts?.ready.then(() => {
      if (!stale) scrollToActive()
    })
    return () => {
      stale = true
    }
  }, [countryId, booted])

  useEffect(() => {
    const onHash = () => {
      setCountryId(countryFromHash())
      setDeepLink(stationFromHash()) // pasted permalinks work mid-session too
      setCompareOpen(isCompareHash(window.location.hash))
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  /** Open/close the compare view, keeping the address bar shareable without
   *  stacking history entries (same replaceState reasoning as writeHash). */
  const showCompare = (open: boolean) => {
    setCompareOpen(open)
    if (open) track('compare-open')
    const h = open ? '#compare' : hashFor(countryId, null)
    window.history.replaceState(null, '', h || window.location.pathname + window.location.search)
  }

  // Station permalinks (#22): consume `#cc/station/<id>` once its country's
  // data has the station (progressive ALL loads may deliver it late), then
  // reuse the search fly-to + pin machinery.
  const [deepLink, setDeepLink] = useState<string | null>(stationFromHash)
  useEffect(() => {
    if (!deepLink || !data) return
    const feature = data.stations.features.find((f) => f.properties.id === deepLink)
    if (!feature) return // not merged yet (ALL) or wrong country — keep waiting
    setSearchTarget({
      id: deepLink,
      coords: feature.geometry.coordinates as [number, number],
      tick: Date.now(),
    })
    setDeepLink(null)
  }, [deepLink, data])

  /** Reflect the pinned station (or its absence) in the address bar. */
  const writeHash = (stationId: string | null) => {
    const h = hashFor(countryId, stationId)
    // replaceState avoids a hashchange feedback loop and browser-history
    // spam (window.history — `history` is this component's mix history).
    window.history.replaceState(null, '', h || window.location.pathname + window.location.search)
  }

  // Escape closes the sidebar whenever it overlays the map — at the one
  // breakpoint the scrim and the drawer layout also use (#13).
  useEffect(() => {
    if (!sidebarAsDialog) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sidebarAsDialog])

  // Closing the drawer hands focus back to the burger that opened it: the
  // close button and the scrim both unmount, so focus would otherwise fall to
  // <body>. This has to be an effect rather than part of the click handler —
  // the topbar is still `inert` until React commits, so focusing the burger
  // any earlier is a no-op. Focus that already landed somewhere real (e.g. a
  // resize to desktop) is left alone (#12).
  const wasDialog = useRef(false)
  useEffect(() => {
    if (wasDialog.current && !sidebarAsDialog) {
      const active = document.activeElement
      if (!active || active === document.body) burgerRef.current?.focus()
    }
    wasDialog.current = sidebarAsDialog
  }, [sidebarAsDialog])

  const switchCountry = (id: CountryId) => {
    window.location.hash = id === DEFAULT_COUNTRY ? '' : id
    setCountryId(id)
    setTimeIndex(null)
    setPlaying(false)
    setSwitchOpen(false)
    setCompareOpen(false) // picking a grid from the compare table lands on it
  }

  // Thirty grids made the chip strip unmanageably long (#2026 run): a sticky
  // "▾" chip opens a wrap-grid sheet with every country named in full, so the
  // strip stays a quick neighbour-hop and the sheet is the overview.
  const [switchOpen, setSwitchOpen] = useState(false)
  const [switchOverflow, setSwitchOverflow] = useState(false)
  // If a resize makes everything fit, the open sheet loses its reason to exist.
  useEffect(() => {
    if (!switchOverflow) setSwitchOpen(false)
  }, [switchOverflow])
  useEffect(() => {
    if (!switchOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSwitchOpen(false)
    }
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element)?.closest?.('.country-switch-wrap')) setSwitchOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [switchOpen])

  const seriesLen = useMemo(() => {
    if (weekScrub) return weekScrub.len // week mode re-scopes the slider (#65)
    if (live?.perStationDay.size) {
      for (const day of live.perStationDay.values()) return day.series.length
    }
    // Mix-only countries (NO/SE/IT) still scrub the mix strip (#17).
    const ms = live?.mixSeries
    if (ms) for (const k in ms) return ms[k]?.length ?? 0
    return 0
  }, [live, weekScrub])

  const stats = useMemo(() => (data ? computeStats(data.stations) : null), [data])
  const totals = useMemo(() => (stats ? totalsFor(stats, enabled) : null), [stats, enabled])
  const mixRows = useMemo(() => {
    if (!live?.mix) return []
    if (live.mixRows) return live.mixRows // ENTSO-E snapshots ship rows ready-made
    if (countryId !== 'gb' || !data || !bmuMap) return []
    return computeMixRows(
      live.mix,
      fleetCapacity(bmuMap, data.stations),
      interconnectorCapacity(data.interconnectors),
    )
  }, [countryId, data, bmuMap, live])

  if (error) {
    return (
      <div className="boot boot--error">
        <p>Couldn’t load grid data: {error}</p>
        {/* useGridData always had a retry — the screen just never offered it. */}
        <button type="button" className="boot-retry" onClick={retry}>
          Try again
        </button>
      </div>
    )
  }
  if (!data || !stats || !totals) {
    return (
      <div className="boot">
        <span className="boot-bolt" aria-hidden="true">
          ⚡
        </span>
        <p>Loading the grid…</p>
      </div>
    )
  }

  const toggleGroup = (id: GroupId) =>
    setEnabled((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className={`shell${sidebarOpen ? '' : ' shell--collapsed'}`}>
      {/* The drawer is modal on phones: everything the scrim covers goes
          inert so Tab and screen-reader browse mode can't wander behind it
          (React 19 takes `inert` as a boolean prop) (#12). */}
      <header className="topbar" inert={sidebarAsDialog}>
        <button
          ref={burgerRef}
          type="button"
          className="burger"
          aria-label={sidebarOpen ? 'Hide legend' : 'Show legend'}
          aria-expanded={sidebarOpen}
          onClick={() => {
            setSidebarOpen((v) => !v)
            setResizeSignal((n) => n + 1)
          }}
        >
          ☰
        </button>
        <h1>
          <span className="bolt" aria-hidden="true">
            ⚡
          </span>
          Grid Atlas
        </h1>
        <div
          className={`country-switch-wrap${switchFades.l ? ' fade-l' : ''}${switchFades.r ? ' fade-r' : ''}${flagsRender ? '' : ' no-flags'}`}
        >
          {/* Toggle buttons rather than a tablist — see MixStrip: no tabpanel
              to control and no arrow-key movement, so tab semantics would be
              a promise the widget doesn't keep. */}
          <div className="country-switch" role="group" aria-label="Country" ref={switchRef}>
            {Object.values(COUNTRIES).map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={c.id === countryId}
                className={`country-btn${c.id === countryId ? ' country-btn--on' : ''}`}
                onClick={() => switchCountry(c.id)}
                title={c.name}
              >
                <span aria-hidden="true">{c.flag}</span> {c.id.toUpperCase()}
              </button>
            ))}
            {switchOverflow && (
              <button
                type="button"
                className="country-btn country-btn-more"
                aria-expanded={switchOpen}
                aria-label={
                  switchOpen ? 'Hide the full country list' : 'Show all countries at once'
                }
                title="All countries"
                onClick={() => setSwitchOpen((o) => !o)}
              >
                {switchOpen ? '▴' : '▾'}
              </button>
            )}
          </div>
          {switchOpen && (
            <div className="country-sheet" role="group" aria-label="All countries">
              {Object.values(COUNTRIES).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={c.id === countryId}
                  className={`country-btn${c.id === countryId ? ' country-btn--on' : ''}`}
                  onClick={() => switchCountry(c.id)}
                >
                  <span aria-hidden="true">{c.flag}</span> {c.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          className="compare-open"
          aria-pressed={compareOpen}
          title="All grids side by side"
          onClick={() => showCompare(!compareOpen)}
        >
          ⇄ <span className="compare-open-label">Compare</span>
        </button>
        <p className="tagline">{country.tagline}</p>
        <div className="headline-stats" aria-live="polite">
          <div className="stat">
            <span className="stat-num">{fmtCount(totals.count)}</span>
            <span className="stat-label">sites shown</span>
          </div>
          <div className="stat">
            <span className="stat-num">{fmtGW(totals.capacityMW)}</span>
            <span className="stat-label">recorded capacity</span>
          </div>
        </div>
        {failures > 0 && (
          <p className="grid-warn" role="status">
            <span aria-hidden="true">⚠</span> {failures} of {total} grids didn’t load — showing the
            rest.{' '}
            <button type="button" className="grid-warn-retry" onClick={retry}>
              retry
            </button>
          </p>
        )}
      </header>

      <Sidebar
        asDialog={sidebarAsDialog}
        onClose={closeSidebar}
        country={country}
        stats={stats}
        enabled={enabled}
        onToggleGroup={toggleGroup}
        onAll={() => setEnabled(allGroupIds())}
        onNone={() => setEnabled(new Set())}
        network={network}
        onNetwork={(patch) => setNetwork((n) => ({ ...n, ...patch }))}
        tiles={tiles}
        onTiles={setTiles}
        meta={data.meta}
        liveStatus={liveStatus}
        live={live}
        liveMode={liveMode}
        onLiveMode={setLiveMode}
      />

      {/* Rendered only while the drawer actually floats over the map — the
          scrim used to be in the DOM on desktop too, hidden by CSS, which is
          invisible to assistive tech but still a tab stop (#12, #13). It stays
          a <button> for the cursor and click semantics but is hidden from
          assistive tech: it does exactly what the drawer's ✕ and Escape
          already do, and two controls sharing one name is just noise. */}
      {sidebarAsDialog && (
        <button
          type="button"
          className="sidebar-scrim"
          tabIndex={-1}
          aria-hidden="true"
          onClick={closeSidebar}
        />
      )}

      <main className="map-pane" inert={sidebarAsDialog}>
        <GridMap
          data={data}
          country={country}
          enabledGroups={enabled}
          network={network}
          tiles={tiles}
          live={live}
          bmuMap={bmuMap}
          liveMode={liveMode}
          resizeSignal={resizeSignal}
          searchTarget={searchTarget}
          timeIndex={timeIndex}
          weekScrub={
            weekScrub
              ? { perStation: weekScrub.perStation, flowSeries: weekScrub.flowSeries }
              : null
          }
          onStationPin={writeHash}
        />
        {!compareOpen && (
          <div className="search-dock">
            <SearchBox
              data={data}
              onSelect={(t) => {
                setSearchTarget(t)
                writeHash(t.id) // picked stations are instantly shareable (#22)
                track('search-pick')
              }}
            />
          </div>
        )}
        {!compareOpen && country.hasLive && liveMode && seriesLen > 0 && (
          <div className="timeslider-dock">
            <TimeSlider
              len={seriesLen}
              index={timeIndex}
              playing={playing}
              meteredDate={live?.meteredDate ?? null}
              weekDates={weekScrub?.dates ?? null}
              liveDiverges={live?.basis === 'elexon'}
              onChange={setTimeIndex}
              onPlayToggle={() => {
                if (!playing) track('slider-play')
                setPlaying((p) => !p)
                if (timeIndex == null) setTimeIndex(0)
              }}
              onReset={() => {
                setPlaying(false)
                setTimeIndex(null)
              }}
            />
          </div>
        )}
        {!compareOpen && country.hasLive && live?.mix && mixRows.length > 0 && (
          <div className="mixstrip-dock">
            {mixOpen ? (
              <MixStrip
                mix={live.mix}
                rows={mixRows}
                timeIndex={timeIndex}
                mixSeries={live.mixSeries}
                importSeries={live.importSeries}
                today={live.today}
                prices={live.prices}
                demandSeries={live.demandSeries}
                meteredDate={live.meteredDate}
                sourceLabel={live.sourceLabel}
                range={mixRange}
                onRange={(r) => {
                  setMixRange(r)
                  track('mix-range', r)
                }}
                history={history}
                historyState={historyState}
                mode={isBaked(live) ? 'daily' : live.source === 'snapshot' ? 'snapshot' : 'live'}
                title={mixTitleFor(country.name, live)}
                onClose={() => setMixOpen(false)}
              />
            ) : (
              <button
                type="button"
                className="mixstrip-reopen"
                aria-label="Show the generation mix panel"
                onClick={() => setMixOpen(true)}
              >
                ⚡ Mix · {fmtGW(live.mix.totalMW + Math.max(0, live.mix.importMW))}
              </button>
            )}
          </div>
        )}
        {compareOpen && (
          <ComparePanel onPick={switchCountry} onClose={() => showCompare(false)} />
        )}
      </main>
    </div>
  )
}
