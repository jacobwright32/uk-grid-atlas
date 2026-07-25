// GB history aggregator tests: Elexon outturn (30-min fuel codes → hourly
// buckets, INT* → signed imports) and volume-weighted Market Index prices.
import { describe, expect, it } from 'vitest'
import { BUCKET_META } from './snapshot-common.mjs'
import { FUEL_KEY, aggregateMidDay, aggregateOutturnDay } from './fetch-gb-history.mjs'

const period = (startTime, data) => ({ startTime, data })

describe('aggregateOutturnDay', () => {
  it('averages two half-hours into one hourly MW figure', () => {
    const { mixSeries } = aggregateOutturnDay([
      period('2026-07-23T14:00:00Z', [{ fuelType: 'CCGT', generation: 7000 }]),
      period('2026-07-23T14:30:00Z', [{ fuelType: 'CCGT', generation: 9000 }]),
    ])
    expect(mixSeries.gas[14]).toBe(8000)
    expect(mixSeries.gas[15]).toBeNull()
  })
  it('merges fuel codes into shared buckets (PS+NPSHYD → hydro)', () => {
    const { mixSeries } = aggregateOutturnDay([
      period('2026-07-23T03:00:00Z', [
        { fuelType: 'PS', generation: 400 },
        { fuelType: 'NPSHYD', generation: 300 },
        { fuelType: 'WIND', generation: 9000 },
      ]),
      period('2026-07-23T03:30:00Z', [
        { fuelType: 'PS', generation: 400 },
        { fuelType: 'NPSHYD', generation: 300 },
        { fuelType: 'WIND', generation: 9000 },
      ]),
    ])
    expect(mixSeries.hydro[3]).toBe(700)
    expect(mixSeries.wind[3]).toBe(9000)
  })
  it('routes INT* to a signed import series, not the mix', () => {
    const { mixSeries, importSeries } = aggregateOutturnDay([
      period('2026-07-23T10:00:00Z', [
        { fuelType: 'INTFR', generation: 1000 },
        { fuelType: 'INTNSL', generation: -700 }, // exporting to Norway
        { fuelType: 'CCGT', generation: 5000 },
      ]),
      period('2026-07-23T10:30:00Z', [
        { fuelType: 'INTFR', generation: 1000 },
        { fuelType: 'INTNSL', generation: -700 },
        { fuelType: 'CCGT', generation: 5000 },
      ]),
    ])
    expect(importSeries[10]).toBe(300) // net import
    expect(mixSeries.gas[10]).toBe(5000)
    expect(Object.keys(mixSeries)).not.toContain('imports')
  })
  it('every fuel code maps to a shared snapshot bucket', () => {
    for (const key of Object.values(FUEL_KEY)) {
      expect(BUCKET_META[key], `bucket ${key}`).toBeTruthy()
    }
  })
})

describe('aggregateMidDay', () => {
  it('volume-weights across providers within the hour', () => {
    const prices = aggregateMidDay([
      { startTime: '2026-07-23T17:00:00Z', price: 100, volume: 1000 },
      { startTime: '2026-07-23T17:30:00Z', price: 200, volume: 3000 },
    ])
    expect(prices[17]).toBe(175) // (100·1000 + 200·3000) / 4000
    expect(prices[18]).toBeNull()
  })
  it('ignores zero-volume rows and returns null with no data', () => {
    expect(aggregateMidDay([{ startTime: '2026-07-23T17:00:00Z', price: 999, volume: 0 }])).toBe(
      null,
    )
    expect(aggregateMidDay([])).toBeNull()
    expect(aggregateMidDay(undefined)).toBeNull()
  })
})
