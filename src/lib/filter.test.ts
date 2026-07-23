import { describe, expect, it } from 'vitest'
import { allGroupIds, computeStats, stationFilter, totalsFor } from './filter'
import type { StationsFC } from './types'

const station = (fuel: string, capacityMW: number | null): StationsFC['features'][number] => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [0, 52] },
  properties: {
    id: `way/${Math.abs(fuel.length * 31 + (capacityMW ?? 7))}`,
    name: 'Test site',
    fuel: fuel as never,
    source: null,
    method: null,
    capacityMW,
    operator: null,
    start: null,
  },
})

const fc = (features: StationsFC['features']): StationsFC => ({
  type: 'FeatureCollection',
  features,
})

describe('stationFilter', () => {
  it('includes granular fuels of enabled groups only', () => {
    const expr = stationFilter(new Set(['hydro']))
    const fuels = (expr[2] as unknown[])[1] as string[]
    expect(fuels).toEqual(expect.arrayContaining(['hydro', 'pumped', 'marine']))
    expect(fuels).not.toContain('gas')
  })

  it('empty selection yields empty fuel list (hides everything)', () => {
    const expr = stationFilter(new Set())
    const fuels = (expr[2] as unknown[])[1] as string[]
    expect(fuels).toHaveLength(0)
  })
})

describe('computeStats / totalsFor', () => {
  const stations = fc([
    station('gas', 1200),
    station('gas', null),
    station('wind_offshore', 1218),
    station('pumped', 1728),
    station('marine', 6),
  ])
  const stats = computeStats(stations)

  it('groups granular fuels under display groups', () => {
    expect(stats.get('gas')).toEqual({ count: 2, capacityMW: 1200, unknownCapacity: 1 })
    // pumped + marine both roll into the hydro display group
    expect(stats.get('hydro')?.count).toBe(2)
    expect(stats.get('hydro')?.capacityMW).toBe(1734)
  })

  it('totalsFor honours the enabled set', () => {
    const all = totalsFor(stats, allGroupIds())
    expect(all.count).toBe(5)
    expect(all.capacityMW).toBe(1200 + 1218 + 1728 + 6)

    const justWind = totalsFor(stats, new Set(['wind_offshore']))
    expect(justWind.count).toBe(1)
    expect(justWind.capacityMW).toBe(1218)
  })
})
