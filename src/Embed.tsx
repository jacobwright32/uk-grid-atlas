/**
 * Embed mode (#97): ?embed=de renders one grid's mix strip and nothing else
 * — no map, no sidebar, and (via main.tsx's dynamic import) none of the
 * maplibre bundle. Small enough for a blog iframe; every embed links back.
 *
 *   <iframe src="https://jacobwright32.github.io/uk-grid-atlas/?embed=de"
 *           width="100%" height="380" style="border:0"></iframe>
 */
import { useEffect, useRef, useState } from 'react'
import MixStrip from './components/MixStrip'
import type { HistoryState, MixRange } from './components/MixStrip'
import { useLiveData } from './hooks/useLiveData'
import { track } from './lib/analytics'
import { COUNTRIES } from './lib/countries'
import type { CountryId } from './lib/countries'
import { computeMixRows } from './lib/fleet'
import { loadHistory } from './lib/history'
import type { HistoryFile } from './lib/history'
import { isBaked, mixTitleFor, sourceMetaFor } from './lib/sources'
import './App.css'

export default function Embed({ countryId }: { countryId: CountryId }) {
  const country = COUNTRIES[countryId]
  const { status, live } = useLiveData(country)
  const [mixRange, setMixRange] = useState<MixRange>('day')
  const [history, setHistory] = useState<HistoryFile | null>(null)
  const [historyState, setHistoryState] = useState<HistoryState>('idle')
  const historyReq = useRef(false)

  useEffect(() => track('embed', countryId), [countryId])

  // Same lazy history load as the app, minus the country-switch machinery —
  // an embed is born and dies on one grid.
  useEffect(() => {
    if (mixRange === 'day' || historyReq.current) return
    historyReq.current = true
    setHistoryState('loading')
    loadHistory(countryId).then((h) => {
      setHistory(h)
      setHistoryState(h ? 'ready' : 'missing')
    })
  }, [mixRange, countryId])

  // GB's browser-live path ships raw fuels; capacity context is map-side
  // furniture the embed doesn't carry, so the bars scale by output alone.
  const mixRows =
    live?.mixRows ?? (live?.mix ? computeMixRows(live.mix, new Map(), 0) : [])

  return (
    <div className="embed-shell">
      <header className="embed-head">
        <span className="embed-title" aria-hidden="true">
          {country.flag} {country.name}
        </span>
        <a
          className="embed-brand"
          href={`./#${countryId}`}
          target="_blank"
          rel="noopener noreferrer"
          title="Open the full atlas"
        >
          ⚡ Grid Atlas ↗
        </a>
      </header>
      {live?.mix && mixRows.length > 0 ? (
        <MixStrip
          mix={live.mix}
          rows={mixRows}
          timeIndex={null}
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
        />
      ) : (
        <p className="embed-empty">
          {status === 'loading' ? 'Loading live data…' : 'No live data available right now.'}
        </p>
      )}
      <footer className="embed-foot">
        Data: {live ? sourceMetaFor(live.sourceLabel).label : country.name} ·{' '}
        <a href={`./#${countryId}`} target="_blank" rel="noopener noreferrer">
          maps, stations and history on the full atlas
        </a>
      </footer>
    </div>
  )
}
