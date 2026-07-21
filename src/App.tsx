import { useEffect, useMemo, useState } from 'react'
import GridMap from './components/GridMap'
import Sidebar from './components/Sidebar'
import MixStrip from './components/MixStrip'
import { useGridData } from './hooks/useGridData'
import { useLiveData } from './hooks/useLiveData'
import { COUNTRIES, countryFromHash } from './lib/countries'
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
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [resizeSignal, setResizeSignal] = useState(0)

  useEffect(() => {
    const onHash = () => setCountryId(countryFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const switchCountry = (id: CountryId) => {
    window.location.hash = id === 'gb' ? '' : id
    setCountryId(id)
  }

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
        <div className="country-switch" role="tablist" aria-label="Country">
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
        />
        {country.hasLive && live?.mix && mixRows.length > 0 && (
          <div className="mixstrip-dock">
            <MixStrip
              mix={live.mix}
              rows={mixRows}
              mode={live.basis === 'entsoe' ? 'daily' : live.source === 'snapshot' ? 'snapshot' : 'live'}
              title={live.basis === 'entsoe' ? `${country.name} generation mix` : 'GB transmission mix'}
            />
          </div>
        )}
      </main>
    </div>
  )
}
