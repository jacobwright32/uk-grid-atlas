import type { MixRow } from '../lib/fleet'
import type { MixSnapshot } from '../lib/live-core.mjs'
import { fmtGW } from '../lib/format'

interface Props {
  mix: MixSnapshot
  rows: MixRow[]
  /** live = instantaneous feed · snapshot = bundled fallback · daily = day average */
  mode: 'live' | 'snapshot' | 'daily'
  title: string
  /** When set, a close button collapses the strip (App renders the reopen chip). */
  onClose?: () => void
}

/**
 * Capacity-vs-output bullet chart, matching the map's visual grammar:
 * ghost track = metered-fleet capacity, bright fill = generating now.
 * Track length ∝ capacity (common scale), fill ∝ utilisation.
 */
export default function MixStrip({ mix, rows, mode, title, onClose }: Props) {
  if (!rows.length) return null
  const maxCap = Math.max(...rows.map((r) => Math.max(r.capMW, r.nowMW)), 1)
  const totalNow = mix.totalMW + Math.max(0, mix.importMW)

  const when = new Date(mix.time)
  const subtitle =
    mode === 'daily'
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
        {rows.map((r) => {
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
          {mode === 'daily'
            ? 'bars = day-average generation (ENTSO-E)'
            : 'bright = generating now · ghost = metered-fleet capacity'}
        </span>
        <span className="mixstrip-note">
          {mode === 'daily'
            ? 'transmission-metered generation'
            : 'solar & embedded not metered here'}
        </span>
      </div>
    </div>
  )
}
