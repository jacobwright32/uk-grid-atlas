import { useMemo } from 'react'
import type { MixRow } from '../lib/fleet'
import type { EntsoeToday } from '../lib/live'
import type { MixSnapshot, PriceDay } from '../lib/live-core.mjs'
import { fmtGW } from '../lib/format'

const CURRENCY_SIGNS: Record<string, string> = { EUR: '€', GBP: '£', PLN: 'zł' }

function fmtPrice(v: number, currency: string): string {
  const sign = CURRENCY_SIGNS[currency]
  const n = Math.round(v)
  return sign ? `${n} ${sign}/MWh` : `${n} ${currency}/MWh`
}

const priceAvg = (p: PriceDay): number | null => {
  const vals = p.series.filter((v): v is number => v != null)
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
}

interface Props {
  mix: MixSnapshot
  rows: MixRow[]
  /** live = instantaneous feed · snapshot = bundled fallback · daily = day average */
  mode: 'live' | 'snapshot' | 'daily'
  title: string
  /** Metered-day interval being scrubbed, or null for the default view (#17). */
  timeIndex: number | null
  /** Per-fuel series keyed like `rows`; intervals match the time slider. */
  mixSeries: Record<string, (number | null)[]> | null
  importSeries: (number | null)[] | null
  /** Today's partial ENTSO-E mix — shown as the default view when present (#18). */
  today: EntsoeToday | null
  /** Wholesale prices over the metered day (scrub basis). */
  prices: PriceDay | null
  /** When set, a close button collapses the strip (App renders the reopen chip). */
  onClose?: () => void
}

/**
 * Capacity-vs-output bullet chart, matching the map's visual grammar:
 * ghost track = metered-fleet capacity, bright fill = generating now.
 * Track length ∝ capacity (common scale), fill ∝ utilisation.
 * While the time slider scrubs, bars show that interval instead (#17).
 */
export default function MixStrip({
  mix,
  rows,
  mode,
  title,
  timeIndex,
  mixSeries,
  importSeries,
  today,
  prices,
  onClose,
}: Props) {
  const len = useMemo(() => {
    if (!mixSeries) return 0
    for (const k in mixSeries) return mixSeries[k]?.length ?? 0
    return 0
  }, [mixSeries])
  const scrubbing = timeIndex != null && mixSeries != null && len > 0
  // Default (non-scrub) view prefers today's partial mix when the snapshot
  // carries one — fresher than the metered day (#18).
  const showToday = !scrubbing && today != null

  const shownRows = useMemo(() => {
    if (scrubbing) {
      return rows.map((r) => {
        const series = r.key === 'imports' ? importSeries : (mixSeries?.[r.key] ?? null)
        const v = series?.[timeIndex] ?? null
        return { ...r, nowMW: v == null ? 0 : Math.abs(v) }
      })
    }
    if (showToday) return today.mixRows
    return rows
  }, [scrubbing, showToday, today, rows, mixSeries, importSeries, timeIndex])

  if (!rows.length) return null
  const maxCap = Math.max(...shownRows.map((r) => Math.max(r.capMW, r.nowMW)), 1)
  const totalNow = scrubbing
    ? shownRows.reduce((a, r) => a + (r.key === 'imports' ? 0 : r.nowMW), 0)
    : showToday
      ? today.totalMW + Math.max(0, today.importMW)
      : mix.totalMW + Math.max(0, mix.importMW)

  const stepMin = len === 48 ? 30 : 60
  const scrubMins = (timeIndex ?? 0) * stepMin
  const scrubHH = String(Math.floor(scrubMins / 60)).padStart(2, '0')
  const scrubMM = String(scrubMins % 60).padStart(2, '0')

  const when = new Date(mix.time)
  const subtitle = scrubbing
    ? `${scrubHH}:${scrubMM}`
    : showToday
      ? `today · through ${String(today.throughHour).padStart(2, '0')}:00`
      : mode === 'daily'
        ? `daily avg · ${when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
        : mode === 'snapshot'
          ? 'snapshot'
          : when.toLocaleTimeString('en-GB', {
              hour: '2-digit',
              minute: '2-digit',
              timeZone: 'Europe/London',
            })

  // Wholesale price line: scrubbing reads the metered day's series at the
  // slider interval; the default view shows today's day-ahead average when
  // available (EU) or the metered day's average (GB market index).
  const priceSource = scrubbing ? prices : (today?.prices ?? prices)
  let priceText: string | null = null
  if (priceSource) {
    const label = mode === 'live' || mode === 'snapshot' ? 'Market index' : 'Day-ahead'
    if (scrubbing) {
      const scale = priceSource.series.length === len ? 1 : priceSource.series.length / len
      const v = priceSource.series[Math.floor(timeIndex * scale)]
      if (v != null)
        priceText = `${label} · ${fmtPrice(v, priceSource.currency)} at ${scrubHH}:${scrubMM}`
    } else {
      const avg = priceAvg(priceSource)
      if (avg != null) {
        const when = today?.prices && priceSource === today.prices ? 'today' : 'day avg'
        const zones = priceSource.zones > 1 ? ` · avg of ${priceSource.zones} zones` : ''
        priceText = `${label} · ${fmtPrice(avg, priceSource.currency)} ${when}${zones}`
      }
    }
  }

  return (
    <div className="mixstrip" role="figure" aria-label="Current GB generation vs fleet capacity">
      <div className="mixstrip-head">
        <span className="mixstrip-title">
          {title} · {subtitle}
        </span>
        <span className="mixstrip-total">{fmtGW(totalNow)}</span>
        {onClose && (
          <button
            type="button"
            className="mixstrip-close"
            aria-label="Hide the generation mix panel"
            title="Hide the mix panel"
            onClick={onClose}
          >
            ✕
          </button>
        )}
      </div>
      <div className="fleet-rows">
        {shownRows.map((r) => {
          const trackPct = (100 * Math.max(r.capMW, r.nowMW)) / maxCap
          const fillPct =
            r.capMW > 0 ? Math.min(100, (100 * r.nowMW) / Math.max(r.capMW, r.nowMW)) : 100
          const util = r.capMW > 0 ? Math.round((100 * r.nowMW) / r.capMW) : null
          return (
            <div
              key={r.key}
              className="fleet-row"
              title={`${r.label}: ${fmtGW(r.nowMW)} of ${fmtGW(r.capMW)} fleet capacity${util != null ? ` (${util}%)` : ''}`}
            >
              <span className="fleet-label">
                <i style={{ background: r.color }} />
                {r.label}
              </span>
              <span className="fleet-bar">
                <span
                  className="fleet-track"
                  style={{ width: `${trackPct}%`, background: r.color }}
                >
                  <span
                    className="fleet-fill"
                    style={{ width: `${fillPct}%`, background: r.color }}
                  />
                </span>
              </span>
              <span className="fleet-nums">
                <b>{fmtGW(r.nowMW)}</b>
                {r.capMW > 0 && <span>/ {fmtGW(r.capMW)}</span>}
              </span>
            </div>
          )
        })}
      </div>
      {priceText && <div className="mixstrip-price">{priceText}</div>}
      <div className="mixstrip-legend">
        <span className="mixstrip-item">
          {scrubbing
            ? `bars = generation at ${scrubHH}:${scrubMM}`
            : showToday
              ? 'bars = today-so-far average (ENTSO-E)'
              : mode === 'daily'
                ? 'bars = day-average generation (ENTSO-E)'
                : 'bright = generating now · ghost = metered-fleet capacity'}
        </span>
        <span className="mixstrip-note">
          {scrubbing
            ? 'drag the slider · reset for the day view'
            : showToday
              ? 'scrub the slider for the metered day'
              : mode === 'daily'
                ? 'transmission-metered generation'
                : 'solar & embedded not metered here'}
        </span>
      </div>
    </div>
  )
}
