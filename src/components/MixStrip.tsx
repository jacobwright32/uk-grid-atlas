import type { MixSnapshot } from '../lib/live-core.mjs'
import { fmtGW } from '../lib/format'

/** Fuel-key colours anchored to the map palette. */
const MIX_COLORS: Record<string, string> = {
  WIND: '#199e70',
  CCGT: '#3987e5',
  OCGT: '#5598e7',
  NUCLEAR: '#9085e9',
  BIOMASS: '#d95926',
  NPSHYD: '#1899ac',
  PS: '#1899ac',
  OIL: '#e66767',
  COAL: '#8a8a85',
  OTHER: '#898781',
  IMPORTS: '#2dd4bf',
}

interface Props {
  mix: MixSnapshot
  isSnapshot: boolean
}

/** Slim stacked bar of the current GB transmission generation mix. */
export default function MixStrip({ mix, isSnapshot }: Props) {
  const segments = [...mix.fuels]
    .sort((a, b) => b.mw - a.mw)
    .map((f) => ({ key: f.key, label: f.label, mw: f.mw }))
  if (mix.importMW > 0) segments.push({ key: 'IMPORTS', label: 'Imports', mw: mix.importMW })
  const total = segments.reduce((a, s) => a + s.mw, 0)
  if (!total) return null

  const when = new Date(mix.time)
  const timeLabel = when.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/London',
  })

  return (
    <div className="mixstrip" role="figure" aria-label="Current GB generation mix">
      <div className="mixstrip-head">
        <span className="mixstrip-title">
          GB transmission mix {isSnapshot ? '· snapshot' : `· ${timeLabel}`}
        </span>
        <span className="mixstrip-total">{fmtGW(total)}</span>
      </div>
      <div className="mixstrip-bar">
        {segments.map((s) => (
          <div
            key={s.key}
            className="mixstrip-seg"
            title={`${s.label}: ${fmtGW(s.mw)} (${Math.round((100 * s.mw) / total)}%)`}
            style={{ width: `${(100 * s.mw) / total}%`, background: MIX_COLORS[s.key] ?? '#898781' }}
          />
        ))}
      </div>
      <div className="mixstrip-legend">
        {segments
          .filter((s) => s.mw / total >= 0.04)
          .map((s) => (
            <span key={s.key} className="mixstrip-item">
              <i style={{ background: MIX_COLORS[s.key] ?? '#898781' }} />
              {s.label} {fmtGW(s.mw)}
            </span>
          ))}
        <span className="mixstrip-note">solar &amp; embedded not metered here</span>
      </div>
    </div>
  )
}
