import { describe, expect, it } from 'vitest'
import {
  aggregateDay,
  aggregatePN,
  currentSettlement,
  daysBefore,
  parseOutturn,
  parseOutturnDay,
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
