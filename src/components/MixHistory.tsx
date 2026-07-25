import { useMemo, useState } from 'react'
import type { HistoryFile } from '../lib/history'
import {
  HISTORY_BUCKETS,
  HISTORY_FALLBACK_COLOR,
  bucketOrder,
  calendarDays,
  shortDate,
  stitchHourly,
} from '../lib/history'
import { fmtGW, fmtPrice } from '../lib/format'

interface Props {
  history: HistoryFile
  range: 'week' | 'month'
}

const W = 360
const H = 104
const TOP_PAD = 6

const colorOf = (key: string) => HISTORY_BUCKETS[key]?.color ?? HISTORY_FALLBACK_COLOR
const labelOf = (key: string) => HISTORY_BUCKETS[key]?.label ?? key

/** Split slot indices into contiguous runs where `covered` is true. */
function runs(n: number, covered: (i: number) => boolean): [number, number][] {
  const out: [number, number][] = []
  let start = -1
  for (let i = 0; i < n; i++) {
    if (covered(i) && start < 0) start = i
    if (!covered(i) && start >= 0) {
      out.push([start, i - 1])
      start = -1
    }
  }
  if (start >= 0) out.push([start, n - 1])
  return out
}

/** Price → y on a padded secondary scale spanning the full chart height. */
function priceScale(prices: (number | null)[]): (v: number) => number {
  const vals = prices.filter((v): v is number => v != null)
  let min = Math.min(...vals)
  let max = Math.max(...vals)
  if (min === max) {
    min -= 1
    max += 1
  }
  return (v) => H - 8 - ((v - min) / (max - min)) * (H - 22)
}

/** Polyline segments for a nullable series (split on gaps). */
function lineSegments(
  series: (number | null)[],
  x: (i: number) => number,
  y: (v: number) => number,
): string[] {
  return runs(series.length, (i) => series[i] != null).map(([a, b]) => {
    const pts: string[] = []
    for (let i = a; i <= b; i++) {
      const v = series[i]
      if (v != null) pts.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    }
    return pts.join(' ')
  })
}

/**
 * Week (stacked hourly areas) and month (stacked daily bars) views of the
 * baked mix history, with the wholesale price as a dashed overlay on its own
 * scale. Hover reads out slot totals; the legend reuses the bucket palette.
 */
export default function MixHistory({ history, range }: Props) {
  const [hover, setHover] = useState<number | null>(null)

  const week = useMemo(
    () => (range === 'week' ? stitchHourly(history.hourly) : null),
    [history, range],
  )
  const month = useMemo(() => {
    if (range !== 'month' || !history.days.length) return null
    const days = history.days
    const firstDay = days[0]
    const lastDay = days[days.length - 1]
    if (!firstDay || !lastDay) return null
    const dates = calendarDays(firstDay.date, lastDay.date)
    const byDate = new Map(days.map((d) => [d.date, d]))
    const keys = bucketOrder(days)
    const prices = dates.map((date) => byDate.get(date)?.price ?? null)
    return { dates, byDate, keys, prices }
  }, [history, range])

  const currency = history.currency ?? 'EUR'
  const n =
    range === 'week' ? (week?.series[week.keys[0] ?? '']?.length ?? 0) : (month?.dates.length ?? 0)
  if (!n) return <div className="mixhistory-empty">no history baked for this grid yet</div>

  const slotW = W / n
  const xCenter = (i: number) => (i + 0.5) * slotW

  // ------------------------------------------------------------ readouts
  let maxTotal = 1
  const totalAt: (number | null)[] = new Array(n).fill(null)
  if (range === 'week' && week) {
    for (let i = 0; i < n; i++) {
      let sum = 0
      let any = false
      for (const k of week.keys) {
        const v = week.series[k]?.[i]
        if (v != null) {
          sum += v
          any = true
        }
      }
      totalAt[i] = any ? sum : null
      if (sum > maxTotal) maxTotal = sum
    }
  } else if (month) {
    month.dates.forEach((date, i) => {
      const d = month.byDate.get(date)
      totalAt[i] = d ? d.totalMW : null
      if (d && d.totalMW > maxTotal) maxTotal = d.totalMW
    })
  }
  const yFor = (v: number) => H - (v / maxTotal) * (H - TOP_PAD)

  const prices = range === 'week' ? week?.prices : (month?.prices ?? null)
  const hasPrices = Boolean(prices?.some((v) => v != null))
  const pScale = hasPrices && prices ? priceScale(prices) : null

  const dateOfSlot = (i: number) =>
    range === 'week' ? (week?.dates[Math.floor(i / 24)] ?? '') : (month?.dates[i] ?? '')

  let readout: string
  if (hover != null && totalAt[hover] != null) {
    const when =
      range === 'week'
        ? `${shortDate(dateOfSlot(hover))} ${String(hover % 24).padStart(2, '0')}:00`
        : shortDate(dateOfSlot(hover))
    const p = prices?.[hover]
    readout = `${when} · ${fmtGW(totalAt[hover] as number)}${
      p != null ? ` · ${fmtPrice(p, currency)}` : ''
    }${range === 'month' ? ' avg' : ''}`
  } else if (hover != null) {
    readout = `${shortDate(dateOfSlot(hover))} · no data`
  } else {
    const covered = totalAt.filter((v): v is number => v != null)
    const avg = covered.length ? covered.reduce((a, b) => a + b, 0) / covered.length : 0
    const pVals = prices?.filter((v): v is number => v != null) ?? []
    const pAvg = pVals.length ? pVals.reduce((a, b) => a + b, 0) / pVals.length : null
    readout = `${shortDate(dateOfSlot(0))} – ${shortDate(dateOfSlot(n - 1))} · avg ${fmtGW(avg)}${
      pAvg != null ? ` · ${fmtPrice(pAvg, currency)}` : ''
    }`
  }

  // ------------------------------------------------------------- shapes
  const shapes: React.ReactNode[] = []
  if (range === 'week' && week) {
    // Stacked areas per contiguous covered run; biggest bucket at the bottom.
    const covered = (i: number) => totalAt[i] != null
    for (const [a, b] of runs(n, covered)) {
      const base = new Array(b - a + 1).fill(0)
      for (const key of week.keys) {
        const s = week.series[key] ?? []
        const top: string[] = []
        const bottom: string[] = []
        for (let i = a; i <= b; i++) {
          const cum = base[i - a] + Math.max(0, s[i] ?? 0)
          base[i - a] = cum
          top.push(`${xCenter(i).toFixed(1)},${yFor(cum).toFixed(1)}`)
          bottom.push(`${xCenter(i).toFixed(1)},${yFor(cum - Math.max(0, s[i] ?? 0)).toFixed(1)}`)
        }
        shapes.push(
          <polygon
            key={`${key}-${a}`}
            points={`${top.join(' ')} ${bottom.reverse().join(' ')}`}
            fill={colorOf(key)}
            fillOpacity={0.92}
          />,
        )
      }
    }
    // Day boundaries.
    for (let d = 1; d < week.dates.length; d++) {
      const x = d * 24 * slotW
      shapes.push(
        <line key={`db-${d}`} x1={x} y1={0} x2={x} y2={H} stroke="#ffffff" strokeOpacity={0.08} />,
      )
    }
  } else if (month) {
    const barW = Math.max(1.5, slotW * 0.68)
    month.dates.forEach((date, i) => {
      const d = month.byDate.get(date)
      if (!d) return
      let cum = 0
      // biggest bucket at the bottom of each bar
      for (const key of month.keys) {
        const mw = d.mix[key] ?? 0
        if (mw <= 0) continue
        const y0 = yFor(cum)
        const y1 = yFor(cum + mw)
        shapes.push(
          <rect
            key={`${date}-${key}`}
            x={xCenter(i) - barW / 2}
            y={y1}
            width={barW}
            height={Math.max(0.5, y0 - y1)}
            fill={colorOf(key)}
            fillOpacity={0.92}
          />,
        )
        cum += mw
      }
    })
  }

  const legendKeys = range === 'week' ? (week?.keys ?? []) : (month?.keys ?? [])

  return (
    <div className="mixhistory">
      <div className="mixhistory-sub">{readout}</div>
      <div
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const i = Math.floor(((e.clientX - rect.left) / rect.width) * n)
          setHover(Math.max(0, Math.min(n - 1, i)))
        }}
        onMouseLeave={() => setHover(null)}
      >
        <svg
          className="mixhistory-svg"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          style={{ height: H }}
          role="img"
          aria-label={`Generation mix over the past ${range}`}
        >
          {shapes}
          {pScale &&
            prices &&
            lineSegments(prices, xCenter, pScale).map((pts, i) =>
              pts.includes(' ') ? (
                <polyline
                  key={`p-${i}`}
                  points={pts}
                  fill="none"
                  stroke="#e8edf4"
                  strokeOpacity={0.85}
                  strokeWidth={1.1}
                  strokeDasharray="3 3"
                />
              ) : null,
            )}
          {hover != null && (
            <line
              x1={xCenter(hover)}
              y1={0}
              x2={xCenter(hover)}
              y2={H}
              stroke="#ffffff"
              strokeOpacity={0.35}
            />
          )}
        </svg>
      </div>
      <div className="mixhistory-dates">
        <span>{shortDate(dateOfSlot(0))}</span>
        {n > 2 && <span>{shortDate(dateOfSlot(Math.floor((n - 1) / 2)))}</span>}
        <span>{shortDate(dateOfSlot(n - 1))}</span>
      </div>
      <div className="mixhistory-legend">
        {legendKeys.map((k) => (
          <span key={k}>
            <i style={{ background: colorOf(k) }} />
            {labelOf(k)}
          </span>
        ))}
        {hasPrices && (
          <span>
            <i className="mixhistory-priceswatch" />
            price ({currency})
          </span>
        )}
      </div>
    </div>
  )
}
