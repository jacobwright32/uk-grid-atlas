// Compare view (#95): row building is pure — every honesty rule the panel
// relies on (label-derived net semantics, suppressed-row nulls, GB's island
// shortcut) is pinned here rather than in the DOM.
import { describe, expect, it } from 'vitest'
import { carbonEstimate, emptyRow, renewableShare, rowFromLive, sortRows } from './compare'
import type { CompareRow } from './compare'
import type { LiveData } from './live'

const NOW = Date.parse('2026-08-03T18:00:00Z')

function makeLive(over: Partial<LiveData>): LiveData {
  return {
    basis: 'entsoe',
    meteredDate: '2026-08-02',
    generatedAt: '2026-08-03T15:00:00Z',
    perStationDay: new Map(),
    perStationNow: null,
    mix: {
      time: '2026-08-02T12:00:00Z',
      fuels: [],
      interconnectors: {},
      totalMW: 1189,
      importMW: -181,
    },
    mixRows: [
      { key: 'coal', label: 'Coal & lignite', color: '#ad7a45', nowMW: 888, capMW: 0 },
      { key: 'hydro', label: 'Hydro & pumped', color: '#1899ac', nowMW: 299, capMW: 0 },
      { key: 'wind', label: 'Wind', color: '#199e70', nowMW: 2, capMW: 0 },
      { key: 'imports', label: 'Net exports', color: '#777', nowMW: 181, capMW: 0 },
    ],
    mixSeries: null,
    importSeries: null,
    flowSeries: null,
    prices: { currency: 'EUR', series: [40, 60, null], zones: 1 },
    demandSeries: null,
    sourceLabel: null,
    today: null,
    source: 'live',
    ...over,
  }
}

describe('carbonEstimate / renewableShare', () => {
  it('matches the shared factor table (lib/carbon ↔ python fuels.py)', () => {
    expect(carbonEstimate([{ key: 'coal', label: '', color: '', mw: 100 }])).toBe(820)
    // The python docstring example: carbon_intensity({wind: 1000, coal: 1000}) == 416
    expect(
      carbonEstimate([
        { key: 'coal', label: '', color: '', mw: 1000 },
        { key: 'wind', label: '', color: '', mw: 1000 },
      ]),
    ).toBe(416)
  })

  it('dilutes with zero-factor storage exactly like the package does', () => {
    expect(
      carbonEstimate([
        { key: 'storage', label: '', color: '', mw: 50 },
        { key: 'gas', label: '', color: '', mw: 50 },
      ]),
    ).toBe(245)
    expect(carbonEstimate([])).toBeNull()
  })

  it('computes the renewable share of all generation', () => {
    expect(
      renewableShare([
        { key: 'wind', label: '', color: '', mw: 50 },
        { key: 'gas', label: '', color: '', mw: 50 },
      ]),
    ).toBe(0.5)
    expect(renewableShare([])).toBeNull()
  })
})

describe('rowFromLive', () => {
  it('reads a measured net position from the post-#93 row label', () => {
    const r = rowFromLive('ba', makeLive({}), NOW)
    expect(r.state).toBe('ok')
    expect(r.totalMW).toBe(1189)
    expect(r.slices.map((s) => s.key)).toEqual(['coal', 'hydro', 'wind'])
    expect(r.netMW).toBe(-181)
    expect(r.netMeasured).toBe(true)
    expect(r.basis).toBe('day')
    expect(r.ageH).toBe(3)
    expect(r.price).toBe(50)
    expect(r.currency).toBe('EUR')
  })

  it('keeps the HVDC qualifier unmeasured', () => {
    const live = makeLive({ importSeries: [120, 200, null] })
    live.mixRows![3] = { ...live.mixRows![3]!, label: 'Imports (HVDC)', nowMW: 181 }
    live.mix = { ...live.mix!, importMW: 181 }
    const r = rowFromLive('nl', live, NOW)
    expect(r.netMW).toBe(181)
    expect(r.netMeasured).toBe(false)
  })

  it('drops the phantom zero-HVDC row of pre-suppression bakes (MixStrip parity)', () => {
    const live = makeLive({ importSeries: [null, null, null] })
    live.mixRows![3] = { ...live.mixRows![3]!, label: 'Imports (HVDC)', nowMW: 0 }
    live.mix = { ...live.mix!, importMW: 0 }
    const r = rowFromLive('rs', live, NOW)
    expect(r.netMW).toBeNull()
    expect(r.netMeasured).toBe(false)
  })

  it('never reads a suppressed imports row as "trades nothing"', () => {
    const live = makeLive({})
    live.mixRows = live.mixRows!.filter((row) => row.key !== 'imports')
    live.mix = { ...live.mix!, importMW: 0 } // the 0 the bake writes when unmeasured
    const r = rowFromLive('hr', live, NOW)
    expect(r.netMW).toBeNull()
    expect(r.netMeasured).toBe(false)
  })

  it('prefers the intraday block when the bake produced one', () => {
    const live = makeLive({
      today: {
        date: '2026-08-03',
        prices: { currency: 'EUR', series: [100], zones: 1 },
        throughHour: 14,
        mixRows: [
          { key: 'solar', label: 'Solar', color: '#c98500', nowMW: 500, capMW: 0 },
          { key: 'imports', label: 'Net imports', color: '#777', nowMW: 120, capMW: 0 },
        ],
        mixSeries: {},
        importSeries: null,
        totalMW: 500,
        importMW: 120,
      },
    })
    const r = rowFromLive('si', live, NOW)
    expect(r.basis).toBe('today')
    expect(r.slices.map((s) => s.key)).toEqual(['solar'])
    expect(r.totalMW).toBe(500)
    expect(r.netMW).toBe(120)
    expect(r.netMeasured).toBe(true)
    expect(r.price).toBe(100)
  })

  it('folds GB FUELINST fuels and trusts the island interconnector set', () => {
    const live = makeLive({
      basis: 'elexon',
      generatedAt: null,
      mixRows: null,
      prices: null,
      mix: {
        time: new Date(NOW - 10 * 60_000).toISOString(),
        fuels: [
          { key: 'CCGT', label: 'Gas', mw: 9000 },
          { key: 'WIND', label: 'Wind', mw: 7000 },
          { key: 'NUCLEAR', label: 'Nuclear', mw: 4000 },
        ],
        interconnectors: {},
        totalMW: 20000,
        importMW: 2500,
      },
    })
    const r = rowFromLive('gb', live, NOW)
    expect(r.basis).toBe('live')
    expect(r.totalMW).toBe(20000)
    expect(r.netMW).toBe(2500)
    expect(r.netMeasured).toBe(true) // every GB border is a metered HVDC link
    expect(r.renewShare).toBeCloseTo(0.35)
    expect(r.ageH).toBeCloseTo(10 / 60, 2)
  })
})

describe('sortRows', () => {
  const rows: CompareRow[] = [
    { ...emptyRow('hr'), state: 'ok', totalMW: 100, carbonEst: 500 },
    { ...emptyRow('si'), state: 'ok', totalMW: 900, carbonEst: 50 },
    emptyRow('mk'), // no data at all
  ]

  it('sorts numerically with missing values always last', () => {
    expect(sortRows(rows, 'total', -1).map((r) => r.id)).toEqual(['si', 'hr', 'mk'])
    expect(sortRows(rows, 'total', 1).map((r) => r.id)).toEqual(['hr', 'si', 'mk'])
    expect(sortRows(rows, 'carbon', -1).map((r) => r.id)).toEqual(['hr', 'si', 'mk'])
  })

  it('sorts names as strings', () => {
    expect(sortRows(rows, 'name', 1).map((r) => r.id)).toEqual(['hr', 'mk', 'si'])
  })
})
