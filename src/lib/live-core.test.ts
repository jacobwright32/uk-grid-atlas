import { describe, expect, it } from 'vitest'
import {
  aggregateDay,
  aggregatePN,
  currentSettlement,
  daysBefore,
  aggregateMID,
  londonDayStartMs,
  parseOutturn,
  parseOutturnDay,
  periodsInDay,
  settlementPeriodAt,
} from './live-core.mjs'

const byUnit = { 'T_AAA-1': 'way/1', 'T_AAA-2': 'way/1', 'T_BBB-1': 'way/2' }

describe('aggregateDay', () => {
  it('sums units per station and converts MWh/half-hour → MW', () => {
    const rows = [
      { bmUnit: 'T_AAA-1', settlementPeriod: 1, quantity: 300 }, // 600 MW
      { bmUnit: 'T_AAA-2', settlementPeriod: 1, quantity: 310 }, // 620 MW
      { bmUnit: 'T_AAA-1', settlementPeriod: 2, quantity: 250 },
      { bmUnit: 'T_AAA-2', settlementPeriod: 2, quantity: 260 },
      { bmUnit: 'T_ZZZ-9', settlementPeriod: 1, quantity: 99 }, // unmapped → ignored
    ]
    const out = aggregateDay(rows, byUnit)
    const s = out.get('way/1')!
    expect(s.series[0]).toBe(1220)
    expect(s.series[1]).toBe(1020)
    expect(s.series[2]).toBeNull()
    expect(s.peakMW).toBe(1220)
    expect(s.periods).toBe(2)
    expect(s.avgMW).toBe(1120)
    expect(s.energyGWh).toBeCloseTo(1.1, 1)
    expect(out.has('way/2')).toBe(false)
  })

  it('clamps negative station house-load to zero in the series', () => {
    const out = aggregateDay([{ bmUnit: 'T_BBB-1', settlementPeriod: 5, quantity: -3.5 }], byUnit)
    expect(out.get('way/2')!.series[4]).toBe(0)
  })
})

describe('aggregatePN', () => {
  it('time-weights level segments and sums per station', () => {
    const rows = [
      // 30 min flat at 400
      {
        bmUnit: 'T_AAA-1',
        timeFrom: '2026-07-21T08:00:00Z',
        timeTo: '2026-07-21T08:30:00Z',
        levelFrom: 400,
        levelTo: 400,
      },
      // ramp 0→300 for 15 min then flat 300 for 15 → mean (150*0.5 + 300*0.5) = 225
      {
        bmUnit: 'T_AAA-2',
        timeFrom: '2026-07-21T08:00:00Z',
        timeTo: '2026-07-21T08:15:00Z',
        levelFrom: 0,
        levelTo: 300,
      },
      {
        bmUnit: 'T_AAA-2',
        timeFrom: '2026-07-21T08:15:00Z',
        timeTo: '2026-07-21T08:30:00Z',
        levelFrom: 300,
        levelTo: 300,
      },
    ]
    const out = aggregatePN(rows, byUnit)
    expect(out.get('way/1')).toBe(625)
  })
})

describe('parseOutturn', () => {
  it('extracts latest instant, maps interconnectors, keeps import total', () => {
    const payload = [
      { startTime: 't0', data: [{ fuelType: 'CCGT', generation: 1 }] },
      {
        startTime: 't1',
        data: [
          { fuelType: 'CCGT', generation: 7000 },
          { fuelType: 'WIND', generation: 9000 },
          { fuelType: 'COAL', generation: 0 },
          { fuelType: 'INTFR', generation: 1500 },
          { fuelType: 'INTNSL', generation: -700 },
        ],
      },
    ]
    const mix = parseOutturn(payload)!
    expect(mix.time).toBe('t1')
    expect(mix.totalMW).toBe(16000)
    expect(mix.fuels.find((f) => f.key === 'COAL')).toBeUndefined()
    expect(mix.interconnectors.ifa).toBe(1500)
    expect(mix.interconnectors.nsl).toBe(-700)
    expect(mix.importMW).toBe(800)
  })

  it('null on empty payload', () => {
    expect(parseOutturn([])).toBeNull()
    expect(parseOutturn(undefined)).toBeNull()
  })
})

describe('parseOutturnDay', () => {
  it('buckets readings into London half-hours and folds interconnectors', () => {
    const payload = [
      {
        // 00:10 BST on 21 Jul (23:10Z on the 20th) -> settlement period index 0
        startTime: '2026-07-20T23:10:00Z',
        data: [
          { fuelType: 'WIND', generation: 5000 },
          { fuelType: 'INTFR', generation: 1000 },
        ],
      },
      {
        // later reading inside the same half-hour wins
        startTime: '2026-07-20T23:25:00Z',
        data: [
          { fuelType: 'WIND', generation: 5200 },
          { fuelType: 'INTFR', generation: 900 },
          { fuelType: 'INTNSL', generation: -400 },
        ],
      },
      {
        // 12:40 BST -> index 25
        startTime: '2026-07-21T11:40:00Z',
        data: [
          { fuelType: 'CCGT', generation: 9000 },
          { fuelType: 'NOTAFUEL', generation: 123 },
        ],
      },
    ]
    const day = parseOutturnDay(payload)!
    expect(day.fuels.WIND![0]).toBe(5200)
    expect(day.imports[0]).toBe(500)
    // #43: per-link series, keyed by map id (INTFR → ifa), + = import
    expect(day.interconnectors.ifa![0]).toBe(900)
    expect(day.interconnectors.nsl![0]).toBe(-400)
    expect(day.interconnectors.ifa![25]).toBeNull()
    expect(day.fuels.CCGT![25]).toBe(9000)
    expect(day.fuels.NOTAFUEL).toBeUndefined()
    expect(day.fuels.WIND![25]).toBeNull()
    expect(day.imports[1]).toBeNull()
  })

  it('null on empty or junk payload', () => {
    expect(parseOutturnDay([])).toBeNull()
    expect(parseOutturnDay([{ startTime: 'garbage', data: [] }])).toBeNull()
  })
})

describe('aggregateMID', () => {
  it('volume-weights across providers per settlement period', () => {
    const rows = [
      { settlementPeriod: 1, price: 100, volume: 300, dataProvider: 'APXMIDP' },
      { settlementPeriod: 1, price: 80, volume: 100, dataProvider: 'N2EXMIDP' },
      { settlementPeriod: 10, price: 55.5, volume: 500, dataProvider: 'APXMIDP' },
      { settlementPeriod: 10, price: 60, volume: 0, dataProvider: 'N2EXMIDP' }, // zero volume ignored
      { settlementPeriod: 99, price: 1, volume: 1, dataProvider: 'APXMIDP' }, // bad period ignored
    ]
    const day = aggregateMID(rows)!
    expect(day.currency).toBe('GBP')
    expect(day.series[0]).toBe(95) // (100*300 + 80*100) / 400
    expect(day.series[9]).toBe(55.5)
    expect(day.series[1]).toBeNull()
  })

  it('null on empty or junk', () => {
    expect(aggregateMID([])).toBeNull()
    expect(aggregateMID(undefined)).toBeNull()
    expect(aggregateMID([{ settlementPeriod: 1, price: 50, volume: 0 }])).toBeNull()
  })
})

describe('settlement helpers', () => {
  it('computes GB settlement period across BST midnight', () => {
    // 23:45 UTC on 20 Jul = 00:45 BST on 21 Jul → period 2 of the 21st
    const s = currentSettlement(new Date('2026-07-20T23:45:00Z'))
    expect(s.settlementDate).toBe('2026-07-21')
    expect(s.settlementPeriod).toBe(2)
  })

  it('daysBefore is calendar-safe', () => {
    expect(daysBefore('2026-03-01', 1)).toBe('2026-02-28')
  })
})

// #5 — GB clock-change days. 25 Oct 2026 is the clocks-back day (50 periods,
// local 01:00-02:00 happens twice); 29 Mar 2026 is clocks-forward (46 periods,
// local 01:00-02:00 never happens).
const LONG_DAY = '2026-10-25'
const SHORT_DAY = '2026-03-29'
const NORMAL_DAY = '2026-07-21'

describe('settlement-period geometry (#5)', () => {
  it('counts 50 periods on the clocks-back day, 46 on clocks-forward, 48 otherwise', () => {
    expect(periodsInDay(LONG_DAY)).toBe(50)
    expect(periodsInDay(SHORT_DAY)).toBe(46)
    expect(periodsInDay(NORMAL_DAY)).toBe(48)
  })

  it('anchors the day to Europe/London midnight, not UTC midnight', () => {
    // BST day → local midnight is 23:00Z the day before; GMT day → 00:00Z.
    expect(new Date(londonDayStartMs(NORMAL_DAY)).toISOString()).toBe('2026-07-20T23:00:00.000Z')
    expect(new Date(londonDayStartMs(LONG_DAY)).toISOString()).toBe('2026-10-24T23:00:00.000Z')
    expect(new Date(londonDayStartMs(SHORT_DAY)).toISOString()).toBe('2026-03-29T00:00:00.000Z')
  })

  it('separates the clocks-back day repeated hour into distinct periods', () => {
    // 01:15 BST (first pass) then 01:15 GMT (second pass) — same wall clock.
    expect(settlementPeriodAt(LONG_DAY, Date.parse('2026-10-25T00:15:00Z'))).toBe(3)
    expect(settlementPeriodAt(LONG_DAY, Date.parse('2026-10-25T01:15:00Z'))).toBe(5)
    // Late evening reaches SP 49/50, unreachable from an hour*2 formula.
    expect(settlementPeriodAt(LONG_DAY, Date.parse('2026-10-25T23:15:00Z'))).toBe(49)
    expect(settlementPeriodAt(LONG_DAY, Date.parse('2026-10-25T23:45:00Z'))).toBe(50)
  })

  it('rejects a date whose period count is not 46/48/50', () => {
    expect(() => periodsInDay('nonsense')).toThrow()
  })
})

describe('aggregateDay on clock-change days (#5)', () => {
  it('keeps SP 49 and 50 of the clocks-back day', () => {
    const rows = [
      { bmUnit: 'T_AAA-1', settlementPeriod: 1, quantity: 100 },
      { bmUnit: 'T_AAA-1', settlementPeriod: 49, quantity: 200 },
      { bmUnit: 'T_AAA-2', settlementPeriod: 49, quantity: 50 },
      { bmUnit: 'T_AAA-1', settlementPeriod: 50, quantity: 150 },
    ]
    const s = aggregateDay(rows, byUnit, LONG_DAY).get('way/1')!
    expect(s.series).toHaveLength(50)
    expect(s.series[48]).toBe(500) // (200 + 50) MWh/hh → MW
    expect(s.series[49]).toBe(300)
    expect(s.periods).toBe(3)
    expect(s.peakMW).toBe(500)
    expect(s.energyGWh).toBeCloseTo(0.5, 1)
  })

  it('sizes the clocks-forward day to 46 periods', () => {
    const rows = [{ bmUnit: 'T_AAA-1', settlementPeriod: 46, quantity: 100 }]
    const s = aggregateDay(rows, byUnit, SHORT_DAY).get('way/1')!
    expect(s.series).toHaveLength(46)
    expect(s.series[45]).toBe(200)
  })

  it('widens past 48 without a date rather than dropping SP 49/50', () => {
    const rows = [{ bmUnit: 'T_AAA-1', settlementPeriod: 50, quantity: 100 }]
    const s = aggregateDay(rows, byUnit).get('way/1')!
    expect(s.series).toHaveLength(50)
    expect(s.series[49]).toBe(200)
  })
})

describe('aggregateMID on clock-change days (#5)', () => {
  it('keeps prices at SP 49/50 of the clocks-back day', () => {
    const rows = [
      { settlementPeriod: 1, price: 40, volume: 100 },
      { settlementPeriod: 49, price: 71.5, volume: 200 },
      { settlementPeriod: 50, price: 66, volume: 100 },
    ]
    const day = aggregateMID(rows, LONG_DAY)!
    expect(day.series).toHaveLength(50)
    expect(day.series[48]).toBe(71.5)
    expect(day.series[49]).toBe(66)
  })

  it('sizes the clocks-forward day to 46 periods and drops out-of-range ones', () => {
    const rows = [
      { settlementPeriod: 46, price: 52, volume: 100 },
      { settlementPeriod: 47, price: 999, volume: 100 }, // does not exist on this day
    ]
    const day = aggregateMID(rows, SHORT_DAY)!
    expect(day.series).toHaveLength(46)
    expect(day.series[45]).toBe(52)
  })
})

describe('parseOutturnDay on clock-change days (#5)', () => {
  it('puts the clocks-back day repeated hour in distinct slots', () => {
    const payload = [
      // 01:10 BST — the first pass through the repeated hour.
      { startTime: '2026-10-25T00:10:00Z', data: [{ fuelType: 'WIND', generation: 5000 }] },
      // 01:10 GMT — the second pass. Same wall clock, one hour later.
      { startTime: '2026-10-25T01:10:00Z', data: [{ fuelType: 'WIND', generation: 6100 }] },
      // 23:40 GMT — inside SP 50, which a 48-slot array cannot hold.
      { startTime: '2026-10-25T23:40:00Z', data: [{ fuelType: 'WIND', generation: 7200 }] },
    ]
    const day = parseOutturnDay(payload, LONG_DAY)!
    expect(day.fuels.WIND!).toHaveLength(50)
    expect(day.fuels.WIND![2]).toBe(5000)
    expect(day.fuels.WIND![4]).toBe(6100)
    expect(day.fuels.WIND![49]).toBe(7200)
  })

  it('leaves no phantom gap where the clocks-forward day skips an hour', () => {
    const payload = [
      { startTime: '2026-03-29T00:10:00Z', data: [{ fuelType: 'WIND', generation: 4000 }] }, // 00:10 GMT
      { startTime: '2026-03-29T01:10:00Z', data: [{ fuelType: 'WIND', generation: 4400 }] }, // 02:10 BST
      { startTime: '2026-03-29T01:40:00Z', data: [{ fuelType: 'WIND', generation: 4600 }] }, // 02:40 BST
    ]
    const day = parseOutturnDay(payload, SHORT_DAY)!
    expect(day.fuels.WIND!).toHaveLength(46)
    expect(day.fuels.WIND![0]).toBe(4000)
    // The old wall-clock bucketing pushed these to slots 4/5 and left 2/3 null
    // forever; the skipped hour simply does not occupy slots.
    expect(day.fuels.WIND![2]).toBe(4400)
    expect(day.fuels.WIND![3]).toBe(4600)
  })
})

describe('currentSettlement on clock-change days (#5)', () => {
  it('returns the high period during the clocks-back repeated hour', () => {
    // 01:15 GMT on 25 Oct — the second pass of local 01:00-02:00. An hour*2
    // formula says 3; the day has already run five half-hours.
    const s = currentSettlement(new Date('2026-10-25T01:15:00Z'))
    expect(s.settlementDate).toBe(LONG_DAY)
    expect(s.settlementPeriod).toBe(5)
  })

  it('reaches period 49/50 late on the clocks-back day', () => {
    expect(currentSettlement(new Date('2026-10-25T23:15:00Z')).settlementPeriod).toBe(49)
    expect(currentSettlement(new Date('2026-10-25T23:45:00Z')).settlementPeriod).toBe(50)
  })

  it('skips the hour that never happens on the clocks-forward day', () => {
    // 03:30 BST on 29 Mar is the sixth half-hour of the day, not the seventh.
    const s = currentSettlement(new Date('2026-03-29T02:30:00Z'))
    expect(s.settlementDate).toBe(SHORT_DAY)
    expect(s.settlementPeriod).toBe(6)
  })
})
