import { describe, expect, it } from 'vitest'
import { bucketOrder, shortDate, stitchHourly } from './history'
import type { HistoryDay, HistoryHourly } from './history'

const hourly = (
  date: string,
  buckets: Record<string, number>,
  prices: number | null = null,
): HistoryHourly => ({
  date,
  mixSeries: Object.fromEntries(
    Object.entries(buckets).map(([k, v]) => [k, new Array(24).fill(v)]),
  ),
  importSeries: null,
  prices: prices == null ? null : new Array(24).fill(prices),
})

describe('stitchHourly', () => {
  it('concatenates days into continuous slots, biggest bucket first', () => {
    const out = stitchHourly([
      hourly('2026-07-23', { wind: 100, gas: 900 }),
      hourly('2026-07-24', { wind: 100, gas: 900 }),
    ])
    expect(out.dates).toEqual(['2026-07-23', '2026-07-24'])
    expect(out.keys).toEqual(['gas', 'wind'])
    expect(out.series.gas ?? []).toHaveLength(48)
    expect(out.series.gas?.[0]).toBe(900)
    expect(out.series.gas?.[47]).toBe(900)
  })
  it('fills nulls for buckets a day never reported', () => {
    const out = stitchHourly([
      hourly('2026-07-23', { gas: 500, coal: 200 }),
      hourly('2026-07-24', { gas: 500 }), // coal plant offline next day
    ])
    expect(out.series.coal?.[0]).toBe(200)
    expect(out.series.coal?.[24]).toBeNull()
  })
  it('keeps calendar gaps as null runs instead of splicing days together', () => {
    const out = stitchHourly([
      hourly('2026-07-20', { gas: 500 }),
      hourly('2026-07-22', { gas: 700 }), // the 21st never got recorded
    ])
    expect(out.dates).toEqual(['2026-07-20', '2026-07-21', '2026-07-22'])
    const gas = out.series.gas ?? []
    expect(gas).toHaveLength(72)
    expect(gas[0]).toBe(500)
    expect(gas[24]).toBeNull() // the missing day stays visible
    expect(gas[48]).toBe(700)
  })
  it('propagates prices only when some day has them', () => {
    const none = stitchHourly([hourly('2026-07-23', { gas: 1 })])
    expect(none.prices).toBeNull()
    const some = stitchHourly([
      hourly('2026-07-23', { gas: 1 }),
      hourly('2026-07-24', { gas: 1 }, 42),
    ])
    expect(some.prices?.[0]).toBeNull()
    expect(some.prices?.[24]).toBe(42)
  })
})

describe('bucketOrder', () => {
  it('orders month buckets by total energy', () => {
    const days: HistoryDay[] = [
      { date: 'a', mix: { wind: 100, gas: 900 }, importMW: null, totalMW: 1000, price: null },
      { date: 'b', mix: { wind: 800, gas: 100 }, importMW: null, totalMW: 900, price: null },
    ]
    expect(bucketOrder(days)).toEqual(['gas', 'wind']) // 1000 vs 900
  })
})

describe('shortDate', () => {
  it('renders compact axis labels', () => {
    expect(shortDate('2026-07-24')).toBe('24 Jul')
  })
})
