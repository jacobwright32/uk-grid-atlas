import type { MapGeoJSONFeature } from 'maplibre-gl'
import { FUEL_COLOR, FUEL_LABEL, LINE_COLORS, TIER_COLORS } from '../lib/fuels'
import { fmtMW, humanise } from '../lib/format'
import type { FuelId, InterconnectorProps, LineProps, StationProps } from '../lib/types'
import type { BmuMap, LiveData } from '../lib/live'
import type { StationDay } from '../lib/live-core.mjs'

/** Context handed in by GridMap so cards can show live figures. */
export interface CardContext {
  live: LiveData | null
  bmuMap: BmuMap | null
  countryName?: string
  /** Active country's voltage tiers — drives the line-card swatch (#2). */
  tierKvs?: [number[], number[], number[]]
}

/** All popup content is built with DOM APIs + textContent — never innerHTML —
 *  so free-text OSM tags (names, operators) can't inject markup. */
function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text != null) node.textContent = text
  return node
}

function row(label: string, value: string | null): HTMLElement | null {
  if (!value) return null
  const r = el('div', 'card-row')
  r.appendChild(el('span', 'card-key', label))
  r.appendChild(el('span', 'card-val', value))
  return r
}

function card(): HTMLElement {
  return el('div', 'hovercard')
}

/** Tiny inline SVG sparkline of a 48-period day (null-safe). */
function sparkline(day: StationDay, color: string): SVGSVGElement {
  const W = 224
  const H = 40
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('class', 'card-spark')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', `Half-hourly output, peak ${fmtMW(day.peakMW)}`)
  const max = Math.max(day.peakMW, 1)
  const n = Math.max(day.series.length - 1, 1)
  const x = (i: number) => (i / n) * (W - 2) + 1
  const y = (mw: number) => H - 3 - (mw / max) * (H - 8)
  let d = ''
  let pen = false
  day.series.forEach((mw, i) => {
    if (mw == null) {
      pen = false
      return
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(mw).toFixed(1)}`
    pen = true
  })
  const base = document.createElementNS(NS, 'line')
  base.setAttribute('x1', '1')
  base.setAttribute('x2', String(W - 1))
  base.setAttribute('y1', String(H - 3))
  base.setAttribute('y2', String(H - 3))
  base.setAttribute('class', 'card-spark-base')
  svg.appendChild(base)
  if (d) {
    const path = document.createElementNS(NS, 'path')
    path.setAttribute('d', d)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', color)
    path.setAttribute('stroke-width', '1.6')
    path.setAttribute('stroke-linejoin', 'round')
    svg.appendChild(path)
  }
  return svg
}

export function stationCard(f: MapGeoJSONFeature, ctx?: CardContext): HTMLElement {
  const p = f.properties as unknown as StationProps
  const fuel = p.fuel as FuelId
  const color = FUEL_COLOR.get(fuel) ?? '#898781'
  const root = card()

  const head = el('div', 'card-head')
  const dot = el('span', 'card-dot')
  dot.style.background = color
  if (fuel === 'pumped') dot.style.boxShadow = '0 0 0 2px #fff inset'
  head.appendChild(dot)
  head.appendChild(el('strong', 'card-title', p.name))
  root.appendChild(head)

  root.appendChild(el('div', 'card-sub', FUEL_LABEL[fuel] ?? 'Power station'))

  const rows = [
    row('Capacity', p.capacityMW != null ? fmtMW(p.capacityMW) : 'not recorded'),
    row('Operator', p.operator),
    row('Since', p.start),
    row('Source', humanise(p.source)),
  ]
  for (const r of rows) if (r) root.appendChild(r)

  // ------------------------------------------------------------ live block
  const live = ctx?.live
  const mapped =
    live?.basis === 'entsoe' ? live.perStationDay.has(p.id) : Boolean(ctx?.bmuMap?.stations[p.id])
  if (live && mapped) {
    const block = el('div', 'card-live')
    const nowMW = live.perStationNow?.get(p.id)
    if (nowMW != null) {
      const r = row(
        'Now (scheduled)',
        `${fmtMW(Math.max(0, nowMW))}${nowMW < -1 ? ' (pumping/charging)' : ''}`,
      )
      if (r) {
        r.classList.add('card-live-now')
        block.appendChild(r)
      }
    }
    const day = live.perStationDay.get(p.id)
    if (day && live.meteredDate) {
      const dateLabel = new Date(`${live.meteredDate}T12:00:00Z`).toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      })
      const lf =
        p.capacityMW && p.capacityMW > 0
          ? ` · ${Math.min(150, Math.round((100 * day.avgMW) / p.capacityMW))}% load factor`
          : ''
      block.appendChild(
        el(
          'div',
          'card-live-head',
          `Metered ${dateLabel}${live.basis === 'entsoe' ? ' (ENTSO-E)' : live.source === 'snapshot' ? ' (snapshot)' : ' · settlement data lags ~a week'}`,
        ),
      )
      const statRows = [
        row('Day average', fmtMW(day.avgMW)),
        row('Day peak', fmtMW(day.peakMW)),
        row('Energy', `${day.energyGWh} GWh`),
      ]
      for (const r of statRows) if (r) block.appendChild(r)
      if (lf)
        block.appendChild(
          el(
            'div',
            'card-live-lf',
            `Ran at ${Math.round((100 * day.avgMW) / (p.capacityMW || 1))}% of capacity on average`,
          ),
        )
      block.appendChild(sparkline(day, color))
    }
    if (block.childNodes.length) root.appendChild(block)
  } else if (live) {
    root.appendChild(
      el(
        'div',
        'card-live-none',
        live.basis === 'entsoe'
          ? 'No unit-level feed — below the 100 MW ENTSO-E reporting threshold'
          : 'No unit-level public feed — distribution-connected site',
      ),
    )
  }

  // Every station is an OSM element — invite fixes at the source (#41).
  if (/^(node|way|relation)\//.test(p.id)) {
    const a = document.createElement('a')
    a.className = 'card-osm'
    a.href = `https://www.openstreetmap.org/${p.id}`
    a.target = '_blank'
    a.rel = 'noopener'
    a.textContent = 'View / improve in OpenStreetMap ↗'
    root.appendChild(a)
  }
  return root
}

export function lineCard(f: MapGeoJSONFeature, ctx?: CardContext): HTMLElement {
  const p = f.properties as unknown as LineProps
  const root = card()
  const head = el('div', 'card-head')
  const swatch = el('span', 'card-line')
  // Swatch follows the active country's tier definition, not fixed EU
  // thresholds (a US 345 kV line is tier 2 there, not backbone).
  const tierIdx = ctx?.tierKvs ? ctx.tierKvs.findIndex((kvs) => kvs.includes(p.v)) : -1
  swatch.style.background =
    TIER_COLORS[(tierIdx >= 0 ? tierIdx : p.v >= 340 ? 0 : p.v >= 200 ? 1 : 2) as 0 | 1 | 2]
  head.appendChild(swatch)
  head.appendChild(el('strong', 'card-title', `${p.v} kV transmission line`))
  root.appendChild(head)
  const rows = [
    row('Name', p.name),
    row('Operator', p.operator),
    row('Circuits', p.circuits ? String(p.circuits) : null),
  ]
  for (const r of rows) if (r) root.appendChild(r)
  if (!p.name && !p.operator) root.appendChild(el('div', 'card-sub', 'Overhead AC circuit'))
  return root
}

export function hvdcCard(f: MapGeoJSONFeature, ctx?: CardContext): HTMLElement {
  const p = f.properties as unknown as InterconnectorProps
  const root = card()
  const head = el('div', 'card-head')
  const swatch = el('span', 'card-line card-line--dash')
  swatch.style.background = LINE_COLORS.hvdc
  head.appendChild(swatch)
  head.appendChild(el('strong', 'card-title', p.name))
  root.appendChild(head)

  root.appendChild(
    el(
      'div',
      'card-sub',
      p.kind === 'interconnector'
        ? `HVDC interconnector · ${p.to}`
        : `HVDC reinforcement · ${p.to}`,
    ),
  )
  if (p.status === 'construction') {
    root.appendChild(el('div', 'card-badge', `Under construction — due ~${p.year}`))
  }

  const flow = ctx?.live?.mix?.interconnectors[p.id]
  if (flow != null && p.status === 'operational') {
    const home = ctx?.countryName ?? 'GB'
    const dir = flow >= 0 ? `importing to ${home}` : `exporting from ${home}`
    const r = row(
      ctx?.live?.basis === 'entsoe' ? 'Flow (day avg)' : 'Flow now',
      `${fmtMW(Math.abs(flow))} — ${dir}`,
    )
    if (r) {
      r.classList.add('card-live-now')
      root.appendChild(r)
    }
  }

  const rows = [
    row('Capacity', fmtMW(p.capMW)),
    row('Voltage', `±${p.kv} kV DC`),
    row(p.status === 'construction' ? 'Due' : 'In service', String(p.year)),
  ]
  for (const r of rows) if (r) root.appendChild(r)
  return root
}

export function cardFor(f: MapGeoJSONFeature, ctx?: CardContext): HTMLElement {
  if (f.layer.id === 'stations' || f.layer.id === 'stations-live') return stationCard(f, ctx)
  if (f.layer.id === 'hvdc') return hvdcCard(f, ctx)
  return lineCard(f, ctx)
}
