import { useEffect, useMemo, useRef, useState } from 'react'
import GridMap from './components/GridMap'
import SearchBox from './components/SearchBox'
import TimeSlider from './components/TimeSlider'
import type { SearchTarget } from './components/SearchBox'
import Sidebar from './components/Sidebar'
import MixStrip from './components/MixStrip'
import { useGridData } from './hooks/useGridData'
import { useLiveData } from './hooks/useLiveData'
import { COUNTRIES, countryFromHash, DEFAULT_COUNTRY } from './lib/countries'
import type { CountryId } from './lib/countries'
import { allGroupIds, computeStats, totalsFor } from './lib/filter'
import { computeMixRows, fleetCapacity, interconnectorCapacity } from './lib/fleet'
import { fmtCount, fmtGW } from './lib/format'
import type { GroupId, NetworkToggles } from './lib/types'
import './App.css'

const DEFAULT_TILES = import.meta.env.VITE_DEFAULT_TILES === '1'

export default function App() {
  const [countryId, setCountryId] = useState<CountryId>(countryFromHash)
  const country = COUNTRIES[countryId]
  const { data, error } = useGridData(countryId)
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
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.matchMedia('(min-width: 640px)').matches,
  )
  // The mix panel crowds small screens — start it collapsed on phones.
  const [mixOpen, setMixOpen] = useState(() => window.matchMedia('(min-width: 640px)').matches)
  const [resizeSignal, setResizeSignal] = useState(0)
  const [searchTarget, setSearchTarget] = useState<SearchTarget | null>(null)
  // Metered-day scrub (#17): null = live/day-average as before.
  const [timeIndex, setTimeIndex] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  // Country switcher scroll affordance: fade the clipped edge(s).
  const switchRef = useRef<HTMLDivElement>(null)
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
    const onHash = () => setCountryId(countryFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Escape closes the sidebar when it overlays the map on small screens.
  useEffect(() => {
    if (!sidebarOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !window.matchMedia('(min-width: 640px)').matches) {
        setSidebarOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sidebarOpen])

  const switchCountry = (id: CountryId) => {
    window.location.hash = id === DEFAULT_COUNTRY ? '' : id
    setCountryId(id)
    setTimeIndex(null)
    setPlaying(false)
  }

  const seriesLen = useMemo(() => {
    if (live?.perStationDay.size) {
      for (const day of live.perStationDay.values()) return day.series.length
    }
    // Mix-only countries (NO/SE/IT) still scrub the mix strip (#17).
    const ms = live?.mixSeries
    if (ms) for (const k in ms) return ms[k]?.length ?? 0
    return 0
  }, [live])

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
      <header className="topbar">
        <button
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
          className={`country-switch-wrap${switchFades.l ? ' fade-l' : ''}${switchFades.r ? ' fade-r' : ''}`}
        >
          <div className="country-switch" role="tablist" aria-label="Country" ref={switchRef}>
            {Object.values(COUNTRIES).map((c) => (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={c.id === countryId}
                className={`country-btn${c.id === countryId ? ' country-btn--on' : ''}`}
                onClick={() => switchCountry(c.id)}
                title={c.name}
              >
                <span aria-hidden="true">{c.flag}</span> {c.id.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
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
      </header>

      <Sidebar
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

      {sidebarOpen && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Close the legend"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <main className="map-pane">
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
        />
        <div className="search-dock">
          <SearchBox data={data} onSelect={setSearchTarget} />
        </div>
        {country.hasLive && liveMode && seriesLen > 0 && (
          <div className="timeslider-dock">
            <TimeSlider
              len={seriesLen}
              index={timeIndex}
              playing={playing}
              meteredDate={live?.meteredDate ?? null}
              onChange={setTimeIndex}
              onPlayToggle={() => {
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
        {country.hasLive && live?.mix && mixRows.length > 0 && (
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
                sourceLabel={live.sourceLabel}
                mode={
                  live.basis === 'entsoe'
                    ? 'daily'
                    : live.source === 'snapshot'
                      ? 'snapshot'
                      : 'live'
                }
                title={
                  live.basis === 'entsoe'
                    ? `${live.sourceLabel === 'IESO' ? 'Ontario' : country.name} generation mix`
                    : 'GB transmission mix'
                }
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
      </main>
    </div>
  )
}
