// US snapshot tests (#59, #51): the combine() every-ISO invariant plus the
// header-mapped NYISO CSV / guarded ERCOT JSON parsers.
import { describe, expect, it } from 'vitest'
import { BUCKET_META } from './snapshot-common.mjs'
import { FUEL_KEY, combine, parseErcot, parseNyisoCsv, rowsFrom } from './fetch-us-snapshot.mjs'

const seriesWith = (entries) => {
  const s = new Array(24).fill(null)
  for (const [h, v] of entries) s[h] = v
  return s
}

describe('combine', () => {
  it('sums per-bucket and rounds', () => {
    const ercot = new Map([['gas', seriesWith([[0, 1000.4]])]])
    const nyiso = new Map([['gas', seriesWith([[0, 200.4]])]])
    expect(combine([ercot, nyiso]).gas[0]).toBe(1201)
  })
  it('nulls any hour not covered by EVERY ISO (no dipping totals)', () => {
    const ercot = new Map([
      [
        'gas',
        seriesWith([
          [0, 1000],
          [1, 1000],
        ]),
      ],
    ])
    const nyiso = new Map([['gas', seriesWith([[0, 200]])]]) // lags an hour
    const out = combine([ercot, nyiso])
    expect(out.gas[0]).toBe(1200)
    expect(out.gas[1]).toBeNull() // ERCOT alone must not look like a collapse
  })
  it("a bucket unique to one ISO still respects the other's coverage", () => {
    const ercot = new Map([
      ['coal', seriesWith([[0, 500]])],
      ['gas', seriesWith([[0, 100]])],
    ])
    const nyiso = new Map([
      [
        'gas',
        seriesWith([
          [0, 50],
          [1, 60],
        ]),
      ],
    ])
    const out = combine([ercot, nyiso])
    expect(out.coal[0]).toBe(500) // hour 0: both ISOs reporting overall
    expect(out.coal[1]).toBeNull() // hour 1: ERCOT dark → gated off
  })
  it('single-ISO input passes through (ERCOT-only degraded mode)', () => {
    const ercot = new Map([['wind', seriesWith([[5, 4321.6]])]])
    const out = combine([ercot])
    expect(out.wind[5]).toBe(4322)
    expect(out.wind[6]).toBeNull()
  })
})

describe('rowsFrom', () => {
  it('builds sorted rows with shared palette labels, no imports row', () => {
    const rows = rowsFrom({
      gas: seriesWith([
        [0, 100],
        [1, 300],
      ]),
      wind: seriesWith([[0, 5000]]),
      solar: new Array(24).fill(null), // never covered → dropped
    })
    expect(rows.map((r) => r.key)).toEqual(['wind', 'gas'])
    expect(rows[0].label).toBe(BUCKET_META.wind.label)
    expect(rows[1].nowMW).toBe(200)
    expect(rows.some((r) => r.key === 'imports')).toBe(false)
  })
})

describe('parseNyisoCsv (#51)', () => {
  const HEADER = 'Time Stamp,Time Zone,Fuel Category,Gen MW'
  it('averages 5-minute rows into hourly buckets by header name', () => {
    const csv = [
      HEADER,
      '07/20/2026 14:05:00,EDT,Natural Gas,1000',
      '07/20/2026 14:10:00,EDT,Natural Gas,2000',
      '07/20/2026 14:05:00,EDT,Other Renewables,50',
      '07/20/2026 15:05:00,EDT,Wind,300',
    ].join('\n')
    const out = parseNyisoCsv(csv)
    expect(out.get('gas')[14]).toBe(1500)
    expect(out.get('biomass')[14]).toBe(50)
    expect(out.get('wind')[15]).toBe(300)
    expect(out.get('gas')[15]).toBeNull() // sparse per-bucket coverage is fine
  })
  it('survives reordered columns (the positional-parse failure mode)', () => {
    const csv = [
      'Fuel Category,Gen MW,Time Stamp,Time Zone',
      'Nuclear,900,07/20/2026 03:05:00,EDT',
    ].join('\n')
    expect(parseNyisoCsv(csv).get('nuclear')[3]).toBe(900)
  })
  it('throws loudly when the header no longer matches', () => {
    expect(() => parseNyisoCsv('A,B,C\n1,2,3')).toThrow(/header changed/)
  })
  it('skips short/blank lines and unknown fuels', () => {
    const csv = [HEADER, '', '07/20/2026 14:05:00,EDT,Mystery Fuel,123', 'junk'].join('\n')
    expect(parseNyisoCsv(csv).size).toBe(0)
  })
})

describe('parseErcot (#51)', () => {
  it('averages 5-minute gen values into hourly buckets per day', () => {
    const doc = {
      data: {
        '2026-07-20': {
          '2026-07-20 14:00:00': { 'Natural Gas': { gen: 30000 }, Wind: { gen: 8000 } },
          '2026-07-20 14:05:00': { 'Natural Gas': { gen: 31000 }, Wind: { gen: 9000 } },
        },
      },
    }
    const days = parseErcot(doc)
    expect(days['2026-07-20'].get('gas')[14]).toBe(30500)
    expect(days['2026-07-20'].get('wind')[14]).toBe(8500)
  })
  it('throws on a changed document shape instead of baking empties', () => {
    expect(() => parseErcot({})).toThrow(/shape changed/)
    expect(() => parseErcot({ data: null })).toThrow(/shape changed/)
  })
  it('tolerates missing gen values and unknown fuels inside a day', () => {
    const doc = {
      data: {
        '2026-07-20': {
          '2026-07-20 01:00:00': { 'Natural Gas': {}, Fusion: { gen: 1 } },
        },
      },
    }
    expect(parseErcot(doc)['2026-07-20'].size).toBe(0)
  })
})

describe('FUEL_KEY', () => {
  it('maps every ISO fuel label onto a shared snapshot bucket', () => {
    for (const key of Object.values(FUEL_KEY)) {
      expect(BUCKET_META[key], `bucket ${key}`).toBeTruthy()
    }
  })
})
