import type { BmuMap } from './live'
import type { MixSnapshot } from './live-core.mjs'
import type { FuelId, InterconnectorsFC, StationsFC } from './types'

/**
 * Buckets that join the two worlds:
 *  - Elexon outturn fuelTypes (live MW, transmission-metered)
 *  - our station fuel groups (BM-registered capacity via bmu-map)
 * Comparing like-for-like: capacity is the *metered fleet's* capacity, not
 * the whole-map OSM capacity (embedded sites never report to this feed).
 */
export interface MixRow {
  key: string
  label: string
  color: string
  nowMW: number
  capMW: number
}

const BUCKETS: {
  key: string
  label: string
  color: string
  elexon: string[]
  fuels: FuelId[]
}[] = [
  {
    key: 'wind',
    label: 'Wind',
    color: '#199e70',
    elexon: ['WIND'],
    fuels: ['wind_offshore', 'wind_onshore'],
  },
  { key: 'gas', label: 'Gas', color: '#3987e5', elexon: ['CCGT', 'OCGT'], fuels: ['gas'] },
  { key: 'nuclear', label: 'Nuclear', color: '#9085e9', elexon: ['NUCLEAR'], fuels: ['nuclear'] },
  {
    key: 'biomass',
    label: 'Biomass & waste',
    color: '#d95926',
    elexon: ['BIOMASS'],
    fuels: ['bioenergy', 'waste'],
  },
  {
    key: 'hydro',
    label: 'Hydro & pumped',
    color: '#1899ac',
    elexon: ['NPSHYD', 'PS'],
    fuels: ['hydro', 'pumped', 'marine'],
  },
  {
    key: 'other',
    label: 'Storage & other',
    color: '#d55181',
    elexon: ['OTHER', 'OIL', 'COAL'],
    fuels: ['storage', 'oil', 'coal', 'other', 'solar'],
  },
]

export const IMPORTS_ROW = { key: 'imports', label: 'Imports', color: '#2dd4bf' }

/**
 * Fold a raw FUELINST day (fuelType-keyed) into bucket-keyed series matching
 * computeMixRows' row keys, so the GB mix strip can scrub (#17).
 */
export function foldMixDay(
  raw: import('./live-core.mjs').MixDaySeries,
): Record<string, (number | null)[]> {
  const out: Record<string, (number | null)[]> = {}
  for (const [fuelType, series] of Object.entries(raw.fuels)) {
    const bucket = BUCKETS.find((b) => b.elexon.includes(fuelType))
    if (!bucket) continue
    const acc = (out[bucket.key] ??= new Array(series.length).fill(null))
    for (let i = 0; i < series.length; i++) {
      const v = series[i]
      if (v == null) continue
      acc[i] = (acc[i] ?? 0) + v
    }
  }
  return out
}

/** BM-registered capacity (MW) per bucket, from mapped stations. */
export function fleetCapacity(bmuMap: BmuMap, stations: StationsFC): Map<string, number> {
  const fuelById = new Map<string, FuelId>()
  for (const f of stations.features) fuelById.set(f.properties.id, f.properties.fuel)

  const capByBucket = new Map<string, number>()
  for (const [stationId, entry] of Object.entries(bmuMap.stations)) {
    const fuel = fuelById.get(stationId)
    if (!fuel) continue
    const bucket = BUCKETS.find((b) => b.fuels.includes(fuel))
    if (!bucket) continue
    const cap = entry.units.reduce((a, u) => a + (u.cap > 0 ? u.cap : 0), 0)
    capByBucket.set(bucket.key, (capByBucket.get(bucket.key) ?? 0) + cap)
  }
  return capByBucket
}

/** Total capacity (MW) of operational external interconnectors. */
export function interconnectorCapacity(ics: InterconnectorsFC): number {
  return ics.features
    .filter((f) => f.properties.kind === 'interconnector' && f.properties.status === 'operational')
    .reduce((a, f) => a + f.properties.capMW, 0)
}

/** Join live mix + fleet capacity into bullet-chart rows (capacity desc). */
export function computeMixRows(
  mix: MixSnapshot,
  capByBucket: Map<string, number>,
  icCapMW: number,
): MixRow[] {
  const nowByKey = new Map<string, number>()
  for (const f of mix.fuels) {
    const bucket = BUCKETS.find((b) => b.elexon.includes(f.key))
    if (!bucket) continue
    nowByKey.set(bucket.key, (nowByKey.get(bucket.key) ?? 0) + f.mw)
  }

  const rows: MixRow[] = []
  for (const b of BUCKETS) {
    const nowMW = nowByKey.get(b.key) ?? 0
    const capMW = capByBucket.get(b.key) ?? 0
    if (nowMW <= 0 && capMW <= 0) continue
    rows.push({ key: b.key, label: b.label, color: b.color, nowMW, capMW })
  }
  rows.sort((a, c) => c.capMW - a.capMW)

  // Imports row last: net flow vs total interconnector capacity.
  rows.push({
    key: IMPORTS_ROW.key,
    label: mix.importMW >= 0 ? 'Imports' : 'Net export',
    color: IMPORTS_ROW.color,
    nowMW: Math.abs(mix.importMW),
    capMW: icCapMW,
  })
  return rows
}
