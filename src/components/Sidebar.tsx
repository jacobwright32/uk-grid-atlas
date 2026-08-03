import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { GROUPS, LINE_COLORS, TIER_COLORS } from '../lib/fuels'
import { fmtCount, fmtGW } from '../lib/format'
import type { StatsByGroup } from '../lib/filter'
import type { GroupId, GridMeta, NetworkToggles } from '../lib/types'
import type { LiveData } from '../lib/live'
import { isBaked, sourceMetaFor } from '../lib/sources'
import type { LiveStatus } from '../hooks/useLiveData'
import { useCoverage } from '../hooks/useCoverage'
import type { GridCoverage } from '../hooks/useCoverage'
import type { CountryConfig } from '../lib/countries'

interface Props {
  /** Narrow viewports only (#12): the panel floats over the map, so it becomes
   *  a modal dialog. Docked on desktop it is plain page furniture. */
  asDialog: boolean
  onClose: () => void
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
  if (isBaked(live) && live)
    return `${sourceMetaFor(live.sourceLabel).label} metered day: ${date ?? '—'} · ${snapshotAgeLabel(live)}`
  return `Latest metered day: ${date ?? '—'} (settles ~a week behind)${live?.perStationNow ? ' · schedules live' : ''}`
}

/**
 * Measured freshness, not a promise. The line used to say "refreshed every
 * 6 h" as a hard-coded string — if the workflow ever died, that claim silently
 * became false. Now the age is computed from the snapshot's own generatedAt.
 */
function snapshotAgeHours(live: LiveData | null): number | null {
  if (!live?.generatedAt) return null
  const t = Date.parse(live.generatedAt)
  if (Number.isNaN(t)) return null
  return Math.max(0, (Date.now() - t) / 3_600_000)
}

function snapshotAgeLabel(live: LiveData | null): string {
  const h = snapshotAgeHours(live)
  if (h == null) return 'refresh cadence: 6 h'
  if (h < 1) return 'updated under an hour ago'
  return `updated ${Math.round(h)} h ago`
}

/**
 * Coverage rows (#96): what this grid measurably publishes, straight from
 * the workflow-baked coverage.json — the per-grid answer to "why does my
 * country show no prices?" that used to live in buried footnotes.
 */
function coverageRows(c: GridCoverage): { label: string; value: string; ok: boolean }[] {
  return [
    {
      label: 'Per-station live',
      value: c.browserLive
        ? 'via browser (Elexon)'
        : c.perStationLive > 0
          ? `${c.perStationLive} stations`
          : 'not published',
      ok: c.browserLive || c.perStationLive > 0,
    },
    { label: 'Intraday mix', value: c.intraday ? 'yes' : 'no', ok: c.intraday },
    {
      label: 'Prices',
      value: c.prices ? `yes${c.currency ? ` (${c.currency})` : ''}` : 'not published',
      ok: c.prices,
    },
    { label: 'Demand', value: c.demand ? 'yes' : 'no', ok: c.demand },
    {
      label: 'Net trade',
      value:
        c.flows === 'net'
          ? 'every border'
          : c.flows === 'hvdc'
            ? 'HVDC links only'
            : 'not measured',
      ok: c.flows !== 'none',
    },
    {
      label: 'History',
      value: `${c.historyDays} days · ${c.hourlyDays} hourly${
        c.perStationHistoryDays ? ` · ${c.perStationHistoryDays} per-station` : ''
      }`,
      ok: c.historyDays > 0,
    },
  ]
}

/** Past two missed refresh cycles the snapshot is officially stale. */
function snapshotIsStale(live: LiveData | null): boolean {
  const h = snapshotAgeHours(live)
  return h != null && h > 12
}

/** Tab order of the drawer. `:not([disabled])` keeps the "size dots by output"
 *  checkbox out of the trap while there's no live data to size by. */
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'

export default function Sidebar({
  asDialog,
  onClose,
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
  const panelRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const coverage = useCoverage(country.id)

  /**
   * Modal behaviour strictly while the drawer floats over the map (#12): focus
   * moves in on open and Tab cycles inside it. Everything behind the scrim is
   * `inert` from App, but `inert` alone leaves focus wherever it was, so the
   * first Tab would still walk out of the drawer and into nothing.
   */
  useEffect(() => {
    if (!asDialog) return
    const panel = panelRef.current
    if (!panel) return
    // The close button, not the first filter: a keyboard user should meet the
    // way out first, and it's the one control the burger behind the scrim hides.
    closeRef.current?.focus()
    // Listening on the document rather than the panel also recovers focus that
    // started outside the drawer (a fresh open with focus still on <body>).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)]
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return
      const active = document.activeElement
      const inside = active != null && panel.contains(active)
      if (e.shiftKey ? active === first || !inside : active === last || !inside) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [asDialog])

  return (
    <aside
      ref={panelRef}
      className="sidebar"
      // Dialog semantics only when it really is one. Docked on desktop this is
      // a permanent complementary landmark, and `aria-modal` would be a lie
      // that hides the rest of the page from screen readers (#12).
      role={asDialog ? 'dialog' : undefined}
      aria-modal={asDialog || undefined}
      aria-label="Legend and filters"
    >
      {asDialog && (
        <button
          ref={closeRef}
          type="button"
          className="sidebar-close"
          aria-label="Close the legend"
          onClick={onClose}
        >
          ✕
        </button>
      )}
      <section>
        <div className="section-head">
          <h2>Live output</h2>
          {/* A bare aria-label on a generic span is ignored — the role gives it
              something to label (#12). */}
          {country.hasLive && liveStatus === 'live' && (
            <span className="live-dot" role="img" aria-label="live" />
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
            <p className={`footnote${snapshotIsStale(live) ? ' footnote--stale' : ''}`}>
              {liveStatusLine(liveStatus, live, country.liveKind)}
              {snapshotIsStale(live) ? ' — the refresh workflow may be down' : ''}
            </p>
            {live && country.liveKind === 'elexon' && (
              <p className="footnote">
                Unit-level data covers transmission-connected stations (~70–80% of GB generation);
                embedded solar &amp; small sites have no public per-site feed.
              </p>
            )}
            {/* Per-grid honesty (#audit): every country carries an authored
                liveNote — ba's missing prices, hr's missing per-unit output,
                rs's 12-day lag. These used to render only on the ALL view;
                the generic source footnote is now just the fallback. */}
            {live && country.liveKind === 'entsoe' && (
              <p className="footnote">
                {country.liveNote || sourceMetaFor(live.sourceLabel).footnote}
              </p>
            )}
            {/* Coverage surface (#96): measured from the baked files by the
                workflow, so "not published" is a fact about the feed, not a
                promise about the app. */}
            {coverage && (
              <details className="coverage">
                <summary>What this grid publishes</summary>
                <dl className="coverage-list">
                  {coverageRows(coverage).map((r) => (
                    <div key={r.label} className={r.ok ? undefined : 'coverage-row--absent'}>
                      <dt>{r.label}</dt>
                      <dd>{r.value}</dd>
                    </div>
                  ))}
                </dl>
                <p className="footnote">Measured from the published files at each bake.</p>
              </details>
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
        {/* Discoverability for the map's roving selection (#12) — the keys are
            useless if nothing on screen mentions them. */}
        <p>
          Keyboard: focus the map, then <kbd>]</kbd> / <kbd>[</kbd> step through the sites currently
          in view, <kbd>Enter</kbd> pins one and <kbd>Esc</kbd> lets go.
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
