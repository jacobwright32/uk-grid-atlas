import { useMemo } from 'react'
import type { MixRow } from '../lib/fleet'
import type { MixSnapshot } from '../lib/live-core.mjs'
import { fmtGW } from '../lib/format'

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
  onClose,
}: Props) {
  const len = useMemo(() => {
    if (!mixSeries) return 0
    for (const k in mixSeries) return mixSeries[k]?.length ?? 0
    return 0
  }, [mixSeries])
  const scrubbing = timeIndex != null && mixSeries != null && len > 0

  const shownRows = useMemo(() => {
    if (!scrubbing) return rows
    return rows.map((r) => {
      const series = r.key === 'imports' ? importSeries : (mixSeries?.[r.key] ?? null)
      const v = series?.[timeIndex] ?? null
      return { ...r, nowMW: v == null ? 0 : Math.abs(v) }
    })
  }, [scrubbing, rows, mixSeries, importSeries, timeIndex])

  if (!rows.length) return null
  const maxCap = Math.max(...shownRows.map((r) => Math.max(r.capMW, r.nowMW)), 1)
  const totalNow = scrubbing
    ? shownRows.reduce((a, r) => a + (r.key === 'imports' ? 0 : r.nowMW), 0)
    : mix.totalMW + Math.max(0, mix.importMW)

  const stepMin = len === 48 ? 30 : 60
  const scrubMins = (timeIndex ?? 0) * stepMin
  const scrubHH = String(Math.floor(scrubMins / 60)).padStart(2, '0')
  const scrubMM = String(scrubMins % 60).padStart(2, '0')

  const when = new Date(mix.time)
  const subtitle = scrubbing
    ? `${scrubHH}:${scrubMM}`
    : mode === 'daily'
      ? `daily avg · ${when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
      : mode === 'snapshot'
        ? 'snapshot'
        : when.toLocaleTimeString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'Europe/London',
          })

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
      <div className="mixstrip-legend">
        <span className="mixstrip-item">
          {scrubbing
            ? `bars = generation at ${scrubHH}:${scrubMM}`
            : mode === 'daily'
              ? 'bars = day-average generation (ENTSO-E)'
              : 'bright = generating now · ghost = metered-fleet capacity'}
        </span>
        <span className="mixstrip-note">
          {scrubbing
            ? 'drag the slider · reset for the day view'
            : mode === 'daily'
              ? 'transmission-metered generation'
              : 'solar & embedded not metered here'}
        </span>
      </div>
    </div>
  )
}
