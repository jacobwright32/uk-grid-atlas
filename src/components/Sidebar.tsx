import type { ReactNode } from 'react'
import { GROUPS, LINE_COLORS, TIER_COLORS } from '../lib/fuels'
import { fmtCount, fmtGW } from '../lib/format'
import type { StatsByGroup } from '../lib/filter'
import type { GroupId, GridMeta, NetworkToggles } from '../lib/types'
import type { LiveData } from '../lib/live'
import type { LiveStatus } from '../hooks/useLiveData'
import type { CountryConfig } from '../lib/countries'

interface Props {
  country: CountryConfig
  stats: StatsByGroup
  enabled: ReadonlySet<GroupId>
  onToggleGroup: (id: GroupId) => void
  onAll: () => void
  onNone: () => void
  network: NetworkToggles
  onNetwork: (patch: Partial<NetworkToggles>) => void
  tiles: boolean
  onTiles: (on: boolean) => void
  meta: GridMeta
  liveStatus: LiveStatus
  live: LiveData | null
  liveMode: boolean
  onLiveMode: (on: boolean) => void
}

function liveStatusLine(status: LiveStatus, live: LiveData | null, kind: string): string {
  if (status === 'loading')
    return kind === 'entsoe' ? 'Loading ENTSO-E snapshot…' : 'Connecting to Elexon…'
  if (status === 'unavailable')
    return kind === 'entsoe'
      ? 'No snapshot yet — add the ENTSOE_TOKEN repo secret and run the "Refresh European live snapshots" workflow.'
      : 'Live feed unreachable — showing infrastructure only.'
  const date = live?.meteredDate
    ? new Date(`${live.meteredDate}T12:00:00Z`).toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      })
    : null
  if (status === 'snapshot') return `Offline — bundled snapshot${date ? ` of ${date}` : ''}.`
  if (live?.basis === 'entsoe') return `ENTSO-E metered day: ${date ?? '—'} · refreshed every 6 h`
  return `Latest metered day: ${date ?? '—'} (settles ~a week behind)${live?.perStationNow ? ' · schedules live' : ''}`
}

export default function Sidebar({
  country,
  stats,
  enabled,
  onToggleGroup,
  onAll,
  onNone,
  network,
  onNetwork,
  tiles,
  onTiles,
  meta,
  liveStatus,
  live,
  liveMode,
  onLiveMode,
}: Props) {
  return (
    <aside className="sidebar" aria-label="Legend and filters">
      <section>
        <div className="section-head">
          <h2>Live output</h2>
          {country.hasLive && liveStatus === 'live' && (
            <span className="live-dot" aria-label="live" />
          )}
        </div>
        {country.hasLive ? (
          <>
            <label className="check-row">
              <input
                type="checkbox"
                checked={liveMode}
                disabled={!live}
                onChange={(e) => onLiveMode(e.target.checked)}
              />
              <span>Size dots by output (bright) over capacity (ghost)</span>
            </label>
            <p className="footnote">{liveStatusLine(liveStatus, live, country.liveKind)}</p>
            {live && country.liveKind === 'elexon' && (
              <p className="footnote">
                Unit-level data covers transmission-connected stations (~70–80% of GB generation);
                embedded solar &amp; small sites have no public per-site feed.
              </p>
            )}
            {live && country.liveKind === 'entsoe' && (
              <p className="footnote">
                Unit-level data covers plants ≥100 MW (ENTSO-E registry); smaller sites appear in
                the mix but not per-station.
              </p>
            )}
          </>
        ) : (
          <p className="footnote">{country.liveNote}</p>
        )}
      </section>

      <section>
        <div className="section-head">
          <h2>Generation</h2>
          <div className="mini-actions">
            <button type="button" onClick={onAll}>
              all
            </button>
            <button type="button" onClick={onNone}>
              none
            </button>
          </div>
        </div>
        <ul className="fuel-list">
          {GROUPS.map((g) => {
            const s = stats.get(g.id)
            if (!s || s.count === 0) return null
            const on = enabled.has(g.id)
            return (
              <li key={g.id}>
                <button
                  type="button"
                  className={`fuel-row${on ? '' : ' fuel-row--off'}`}
                  aria-pressed={on}
                  onClick={() => onToggleGroup(g.id)}
                >
                  <span className="fuel-dot" style={{ background: g.color }} aria-hidden="true" />
                  <span className="fuel-label">{g.label}</span>
                  <span className="fuel-nums">
                    <span className="fuel-count">{s ? fmtCount(s.count) : '0'}</span>
                    <span className="fuel-gw">
                      {s && s.capacityMW > 0 ? fmtGW(s.capacityMW) : '·'}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        <p className="footnote">
          Site count · recorded capacity. Capacity is missing for some sites in the source data, so
          totals understate reality.
        </p>
      </section>

      <section>
        <div className="section-head">
          <h2>Network</h2>
        </div>
        <ul className="net-list">
          {country.tiers.map((tier, i) => {
            const key = (['t1', 't2', 't3'] as const)[i]!
            if (!tier.kvs.length) return null
            return (
              <NetRow
                key={key}
                label={tier.label}
                swatch={<LineSwatch color={TIER_COLORS[i] ?? TIER_COLORS[2]} w={3 - i * 0.7} />}
                on={network[key]}
                onClick={() => onNetwork({ [key]: !network[key] })}
              />
            )
          })}
          <NetRow
            label="HVDC links & interconnectors"
            swatch={<LineSwatch color={LINE_COLORS.hvdc} w={2.2} dashed />}
            on={network.hvdc}
            onClick={() => onNetwork({ hvdc: !network.hvdc })}
          />
          {network.hvdc && (
            <NetRow
              label="…include under construction"
              sub
              swatch={<LineSwatch color={LINE_COLORS.hvdc} w={2.2} dashed faded />}
              on={network.construction}
              onClick={() => onNetwork({ construction: !network.construction })}
            />
          )}
        </ul>
      </section>

      <section>
        <div className="section-head">
          <h2>Basemap</h2>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={tiles} onChange={(e) => onTiles(e.target.checked)} />
          <span>Detailed basemap (online tiles)</span>
        </label>
      </section>

      <section className="about">
        <p>
          Sites are sized by installed capacity — hover any dot or line for details, click to pin.
          Wind farms are split on/offshore automatically
          {country.id === 'gb' ? '; pumped-storage hydro wears a white ring' : ''}.
        </p>
        <p className="footnote">
          Data: © OpenStreetMap contributors (ODbL), extract {meta.generated}. Interconnectors
          curated from operator publications. Coastline: Natural Earth. This is an infrastructure
          atlas, not a live-output feed.
        </p>
      </section>
    </aside>
  )
}

function NetRow({
  label,
  swatch,
  on,
  onClick,
  sub,
}: {
  label: string
  swatch: ReactNode
  on: boolean
  onClick: () => void
  sub?: boolean
}) {
  return (
    <li>
      <button
        type="button"
        className={`fuel-row${on ? '' : ' fuel-row--off'}${sub ? ' fuel-row--sub' : ''}`}
        aria-pressed={on}
        onClick={onClick}
      >
        {swatch}
        <span className="fuel-label">{label}</span>
      </button>
    </li>
  )
}

function LineSwatch({
  color,
  w,
  dashed,
  faded,
}: {
  color: string
  w: number
  dashed?: boolean
  faded?: boolean
}) {
  return (
    <span className="line-swatch" aria-hidden="true" style={{ opacity: faded ? 0.45 : 1 }}>
      <span
        style={{
          background: dashed
            ? `repeating-linear-gradient(90deg, ${color} 0 6px, transparent 6px 10px)`
            : color,
          height: w,
        }}
      />
    </span>
  )
}
