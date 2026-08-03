/**
 * Compare view (#95): every grid as one sortable table row — generation,
 * mix bar, estimated carbon intensity, price, net trade, freshness. Opens
 * at #compare over the map; rows fill in as their snapshots land.
 */
import { useEffect, useRef, useState } from 'react'
import { loadCompareRows, sortRows } from '../lib/compare'
import type { CompareRow, CompareSortKey } from '../lib/compare'
import { fmtGW, fmtPrice } from '../lib/format'
import type { CountryId } from '../lib/countries'

interface Props {
  onPick: (id: CountryId) => void
  onClose: () => void
}

const COLS: { key: CompareSortKey; label: string; title?: string }[] = [
  { key: 'name', label: 'Grid' },
  { key: 'total', label: 'Generation', title: 'Generation — imports excluded' },
  { key: 'renew', label: 'Mix', title: 'Share by source · sorts by renewable share' },
  {
    key: 'carbon',
    label: 'est. CO₂',
    title: 'Estimated gCO₂eq/kWh — IPCC lifecycle medians over the generation mix',
  },
  { key: 'price', label: 'Price', title: 'Day-average wholesale price' },
  { key: 'net', label: 'Net trade', title: '+ import · − export · † mapped HVDC links only' },
  { key: 'age', label: 'Updated' },
]

/** Reopening within a session shouldn't refetch 32 files. */
let cache: { rows: CompareRow[]; at: number } | null = null
const CACHE_TTL = 5 * 60_000

function carbonClass(g: number): string {
  if (g < 100) return 'co2--low'
  if (g < 300) return 'co2--mid'
  return 'co2--high'
}

function ageLabel(r: CompareRow): string {
  if (r.ageH == null) return '—'
  if (r.basis === 'live') return 'live'
  if (r.ageH < 1) return '<1 h'
  return `${Math.round(r.ageH)} h`
}

function netLabel(r: CompareRow): string {
  if (r.netMW == null) return '—'
  const arrow = r.netMW >= 0 ? '▲' : '▼'
  const dagger = r.netMeasured ? '' : '†'
  return `${arrow} ${fmtGW(Math.abs(r.netMW))}${dagger}`
}

export default function ComparePanel({ onPick, onClose }: Props) {
  const [rows, setRows] = useState<CompareRow[]>(() =>
    cache && Date.now() - cache.at < CACHE_TTL ? cache.rows : [],
  )
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [sort, setSort] = useState<{ key: CompareSortKey; dir: 1 | -1 }>({
    key: 'total',
    dir: -1,
  })
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (cache && Date.now() - cache.at < CACHE_TTL) return
    let cancelled = false
    loadCompareRows((partial, done, total) => {
      if (cancelled) return
      setRows(partial)
      setProgress(done < total ? { done, total } : null)
    }).then((all) => {
      cache = { rows: all, at: Date.now() }
      if (!cancelled) setProgress(null)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // The panel is a takeover: Escape leaves it like the other overlays.
  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const onSort = (key: CompareSortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === 1 ? -1 : 1 }
        : // Fresh column: names read A→Z, numbers biggest-first.
          { key, dir: key === 'name' ? 1 : -1 },
    )

  const sorted = sortRows(rows, sort.key, sort.dir)
  const maxTotal = Math.max(1, ...rows.map((r) => r.totalMW))

  return (
    <section className="compare-panel" role="dialog" aria-label="Compare all grids">
      <header className="compare-head">
        <h2>Compare all grids</h2>
        {progress && (
          <span className="compare-progress" role="status">
            loading {progress.done} of {progress.total}…
          </span>
        )}
        <button
          ref={closeRef}
          type="button"
          className="compare-close"
          aria-label="Close the compare view"
          onClick={onClose}
        >
          ✕
        </button>
      </header>
      <div className="compare-scroll">
        <table className="compare-table">
          <thead>
            <tr>
              {COLS.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={
                    sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined
                  }
                >
                  <button
                    type="button"
                    className="compare-sort"
                    title={c.title}
                    onClick={() => onSort(c.key)}
                  >
                    {c.label}
                    {sort.key === c.key && (
                      <span aria-hidden="true"> {sort.dir === 1 ? '↑' : '↓'}</span>
                    )}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id} className={r.state === 'none' ? 'compare-row--none' : undefined}>
                <th scope="row">
                  <button type="button" className="compare-grid" onClick={() => onPick(r.id)}>
                    <span aria-hidden="true">{r.flag}</span> {r.name}
                  </button>
                </th>
                {r.state === 'none' ? (
                  <td className="compare-none" colSpan={COLS.length - 1}>
                    no live data yet
                  </td>
                ) : (
                  <>
                    <td className="compare-num">{fmtGW(r.totalMW)}</td>
                    <td>
                      <div
                        className="compare-bar"
                        style={{ width: `${Math.max(8, (100 * r.totalMW) / maxTotal)}%` }}
                        title={r.slices
                          .slice(0, 4)
                          .map((s) => `${s.label} ${Math.round((100 * s.mw) / r.totalMW)}%`)
                          .join(' · ')}
                      >
                        {r.slices.map((s) => (
                          <span
                            key={s.key}
                            style={{ flexGrow: s.mw, background: s.color }}
                            aria-hidden="true"
                          />
                        ))}
                      </div>
                      <span className="compare-renew">
                        {r.renewShare != null ? `${Math.round(r.renewShare * 100)}% renewable` : ''}
                      </span>
                    </td>
                    <td className="compare-num">
                      {r.carbonEst != null ? (
                        <span className={`co2 ${carbonClass(r.carbonEst)}`}>{r.carbonEst}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="compare-num">
                      {r.price != null && r.currency ? fmtPrice(r.price, r.currency) : '—'}
                    </td>
                    <td
                      className="compare-num"
                      title={
                        r.netMW == null
                          ? 'not measured'
                          : r.netMeasured
                            ? 'net position over every border'
                            : 'mapped HVDC links only'
                      }
                    >
                      {netLabel(r)}
                    </td>
                    <td className="compare-num">{ageLabel(r)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer className="compare-foot">
        est. CO₂ is a lifecycle estimate (IPCC AR5 medians) over generation only — imports and
        storage excluded. Net trade: ▲ import, ▼ export; † counts mapped HVDC links only, not
        every border. Prices are day averages in local basis; GB's is its latest settled day.
      </footer>
    </section>
  )
}
