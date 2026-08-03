// Coverage builder (#96): measured claims, not promised ones.
import { describe, expect, it } from 'vitest'
import { coverageForGrid } from './build-coverage.mjs'

const SNAP = {
  date: '2026-08-02',
  generatedAt: '2026-08-03T12:00:00Z',
  sourceLabel: null,
  perStation: {
    'way/1': { series: [100, 120] },
    'way/2': { series: [null, null] }, // mapped but silent — not live coverage
  },
  today: { date: '2026-08-03', prices: { series: [50] }, demandSeries: null },
  prices: { series: [40, 45], currency: 'EUR' },
  demandSeries: [900, 950],
  netImportSeries: [10, -20],
  importSeries: [null, null],
  flowSeries: { norned: [100, 90] },
}

const HIST = {
  currency: 'EUR',
  days: [
    { date: '2026-07-04', price: 40, demandMW: 900 },
    { date: '2026-07-05', price: null, demandMW: null },
  ],
  hourly: [
    { date: '2026-08-01', perStation: { 'way/1': [1, 2] } },
    { date: '2026-08-02', perStation: {} },
  ],
}

describe('coverageForGrid', () => {
  it('measures everything from the files', () => {
    const c = coverageForGrid('at', SNAP, HIST)
    expect(c.snapshot).toBe(true)
    expect(c.perStationLive).toBe(1) // way/2 is all-null
    expect(c.intraday).toBe(true)
    expect(c.prices).toBe(true)
    expect(c.demand).toBe(true)
    expect(c.flows).toBe('net')
    expect(c.links).toBe(1)
    expect(c.historyDays).toBe(2)
    expect(c.hourlyDays).toBe(2)
    expect(c.perStationHistoryDays).toBe(1)
    expect(c.priceDays).toBe(1)
    expect(c.demandDays).toBe(1)
    expect(c.currency).toBe('EUR')
  })

  it('grades flows hvdc when only link series are measured, none when nothing is', () => {
    expect(
      coverageForGrid('nl', { ...SNAP, netImportSeries: null, importSeries: [5, 6] }, HIST).flows,
    ).toBe('hvdc')
    expect(
      coverageForGrid('hr', { ...SNAP, netImportSeries: null, importSeries: [null] }, HIST).flows,
    ).toBe('none')
  })

  it('a grid with no snapshot still reports its history coverage', () => {
    const c = coverageForGrid('xx', null, HIST)
    expect(c.snapshot).toBe(false)
    expect(c.perStationLive).toBe(0)
    expect(c.prices).toBe(true) // one priced history day IS published prices
    expect(c.historyDays).toBe(2)
  })

  it('GB is browser-live: no snapshot file, but live claims hold', () => {
    const c = coverageForGrid('gb', null, HIST)
    expect(c.browserLive).toBe(true)
    expect(c.source).toBe('Elexon')
    expect(c.intraday).toBe(true)
    expect(c.flows).toBe('net')
  })

  it('reads all-null price series as unpublished', () => {
    // prices=true needs SOME value somewhere — snapshot, intraday or history.
    const bare = {
      ...SNAP,
      prices: { series: [null], currency: 'BAM' },
      today: { ...SNAP.today, prices: { series: [null] } },
    }
    const noPricedDays = { ...HIST, days: HIST.days.map((d) => ({ ...d, price: null })) }
    expect(coverageForGrid('ba', bare, noPricedDays).prices).toBe(false)
    expect(coverageForGrid('ba', bare, HIST).prices).toBe(true)
  })
})
