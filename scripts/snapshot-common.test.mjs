// Shared snapshot-helper tests (#52): the three live fetchers all lean on
// these — a semantics change here would drift every baked snapshot at once.
import { describe, expect, it } from 'vitest'
import {
  BUCKET_META,
  FALLBACK_COLOR,
  IMPORTS_COLOR,
  accAdd,
  accMeanSeries,
  accSumSeries,
  buildMixRows,
  buildStationDay,
  compactDate,
  hourOfPosition,
  isoDaysAgo,
  makeHourlyAcc,
  meanCovered,
  throughHour,
} from './snapshot-common.mjs'

describe('BUCKET_META', () => {
  it('covers the nine snapshot buckets with labels and hex colours', () => {
    const keys = Object.keys(BUCKET_META)
    expect(keys.sort()).toEqual(
      ['biomass', 'coal', 'gas', 'geothermal', 'hydro', 'nuclear', 'other', 'solar', 'wind'].sort(),
    )
    for (const meta of Object.values(BUCKET_META)) {
      expect(meta.label).toBeTruthy()
      expect(meta.color).toMatch(/^#[0-9a-f]{6}$/)
    }
    expect(FALLBACK_COLOR).toMatch(/^#[0-9a-f]{6}$/)
    expect(IMPORTS_COLOR).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe('hourly accumulator', () => {
  it('sumSeries: energy-weighted hour totals (ENTSO-E quarter-hours)', () => {
    const acc = makeHourlyAcc()
    // four 15-min points of 100 MW → one hour of 100 MW
    for (let i = 0; i < 4; i++) accAdd(acc, 'wind', 0, 100, 15 / 60)
    // two of the four quarters at 200 → half-covered hour sums to 100
    accAdd(acc, 'wind', 1, 200, 15 / 60)
    accAdd(acc, 'wind', 1, 200, 15 / 60)
    const s = accSumSeries(acc, 'wind')
    expect(s[0]).toBeCloseTo(100)
    expect(s[1]).toBeCloseTo(100)
    expect(s[2]).toBeNull()
  })
  it('meanSeries: plain average (5-min US ISO points, prices)', () => {
    const acc = makeHourlyAcc()
    accAdd(acc, 'gas', 3, 100)
    accAdd(acc, 'gas', 3, 200)
    expect(accMeanSeries(acc, 'gas')[3]).toBeCloseTo(150)
    expect(accMeanSeries(acc, 'gas')[4]).toBeNull()
  })
  it('ignores out-of-range hours and non-finite values', () => {
    const acc = makeHourlyAcc()
    accAdd(acc, 'x', -1, 100)
    accAdd(acc, 'x', 24, 100)
    accAdd(acc, 'x', 5, NaN)
    expect(accSumSeries(acc, 'x')).toBeNull() // nothing ever landed
  })
  it('returns null for unknown keys', () => {
    expect(accSumSeries(makeHourlyAcc(), 'nope')).toBeNull()
    expect(accMeanSeries(makeHourlyAcc(), 'nope')).toBeNull()
  })
})

describe('hourOfPosition', () => {
  it('maps 1-based positions across resolutions', () => {
    expect(hourOfPosition(1, 60)).toBe(0)
    expect(hourOfPosition(24, 60)).toBe(23)
    expect(hourOfPosition(1, 15)).toBe(0)
    expect(hourOfPosition(5, 15)).toBe(1)
    expect(hourOfPosition(96, 15)).toBe(23)
    expect(hourOfPosition(48, 30)).toBe(23)
  })
})

describe('meanCovered / throughHour', () => {
  it('averages only the covered slots', () => {
    expect(meanCovered([100, null, 200, null])).toBe(150)
    expect(meanCovered([null, null])).toBe(0)
  })
  it('throughHour: last covered hour across buckets, 1-based', () => {
    expect(throughHour({})).toBe(0)
    const a = new Array(24).fill(null)
    a[9] = 50
    const b = new Array(24).fill(null)
    b[14] = 20
    expect(throughHour({ a, b })).toBe(15)
  })
})

describe('buildStationDay', () => {
  it('rounds series and derives periods/avg/peak/energy', () => {
    const series = new Array(24).fill(null)
    series[0] = 100.26
    series[1] = 200.04
    const d = buildStationDay(series)
    expect(d.series[0]).toBe(100.3)
    expect(d.series[1]).toBe(200)
    expect(d.periods).toBe(2)
    expect(d.avgMW).toBeCloseTo(150.2, 1)
    expect(d.peakMW).toBeCloseTo(200, 1)
    expect(d.energyGWh).toBeCloseTo(0.3) // 300.3 MWh → 0.3 GWh
  })
  it('returns null for an empty day', () => {
    expect(buildStationDay(new Array(24).fill(null))).toBeNull()
  })
})

describe('buildMixRows', () => {
  it('sorts descending, labels from BUCKET_META, drops zero rows', () => {
    const { rows, totalMW } = buildMixRows(
      new Map([
        ['gas', 500.4],
        ['wind', 1200.2],
        ['solar', 0.2], // rounds to 0 → dropped
      ]),
    )
    expect(rows.map((r) => r.key)).toEqual(['wind', 'gas'])
    expect(rows[0].label).toBe('Wind')
    expect(rows[0].color).toBe(BUCKET_META.wind.color)
    expect(totalMW).toBe(1700)
  })
  it('appends an imports row only when importMW is a number', () => {
    const none = buildMixRows(new Map([['gas', 100]]))
    expect(none.rows.some((r) => r.key === 'imports')).toBe(false)

    const imp = buildMixRows(new Map([['gas', 100]]), 250)
    const row = imp.rows.find((r) => r.key === 'imports')
    expect(row.label).toBe('Imports (HVDC)')
    expect(row.nowMW).toBe(250)
    expect(imp.totalMW).toBe(100) // imports excluded from the total

    const exp = buildMixRows(new Map([['gas', 100]]), -80)
    expect(exp.rows.find((r) => r.key === 'imports').label).toBe('Net export (HVDC)')
    expect(exp.rows.find((r) => r.key === 'imports').nowMW).toBe(80)
  })
  it('falls back to key + FALLBACK_COLOR for unknown buckets', () => {
    const { rows } = buildMixRows(new Map([['mystery', 10]]))
    expect(rows[0].label).toBe('mystery')
    expect(rows[0].color).toBe(FALLBACK_COLOR)
  })
})

describe('dates', () => {
  it('isoDaysAgo yields ISO dates in strictly reverse order', () => {
    expect(isoDaysAgo(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(isoDaysAgo(1) < isoDaysAgo(0)).toBe(true)
  })
  it('compactDate strips hyphens', () => {
    expect(compactDate('2026-07-24')).toBe('20260724')
  })
})
