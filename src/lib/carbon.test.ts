import { describe, expect, it } from 'vitest'
import { CARBON_FACTORS, fmtIntensity, intensityOf, intensityOfMix } from './carbon'

describe('intensityOf (#21)', () => {
  it('weights factors by generation', () => {
    // 1 GW coal (820) + 1 GW wind (12) → 416
    expect(
      intensityOf([
        { key: 'coal', nowMW: 1000 },
        { key: 'wind', nowMW: 1000 },
      ]),
    ).toBe(416)
  })
  it('a fully renewable mix reads low, fossil reads high', () => {
    const green = intensityOf([
      { key: 'wind', nowMW: 3000 },
      { key: 'hydro', nowMW: 1000 },
    ])!
    const dark = intensityOf([
      { key: 'coal', nowMW: 2000 },
      { key: 'gas', nowMW: 2000 },
    ])!
    expect(green).toBeLessThan(30)
    expect(dark).toBeGreaterThan(600)
  })
  it('excludes imports and unknown buckets from both sides of the ratio', () => {
    const withImports = intensityOf([
      { key: 'gas', nowMW: 1000 },
      { key: 'imports', nowMW: 5000 },
      { key: 'mystery', nowMW: 5000 },
    ])
    expect(withImports).toBe(CARBON_FACTORS.gas)
  })
  it('returns null when nothing attributable is generating', () => {
    expect(intensityOf([])).toBeNull()
    expect(intensityOf([{ key: 'imports', nowMW: 500 }])).toBeNull()
    expect(intensityOf([{ key: 'wind', nowMW: 0 }])).toBeNull()
  })
  it('covers every snapshot and GB fleet bucket', () => {
    for (const key of [
      'wind',
      'solar',
      'gas',
      'nuclear',
      'coal',
      'geothermal',
      'biomass',
      'hydro',
      'other',
      'pumped',
      'storage',
    ]) {
      expect(CARBON_FACTORS[key], key).toBeDefined()
    }
  })
})

describe('intensityOfMix / fmtIntensity', () => {
  it('reads history day records directly', () => {
    expect(intensityOfMix({ coal: 1000, wind: 1000 })).toBe(416)
  })
  it('formats compactly', () => {
    expect(fmtIntensity(142)).toBe('142 g/kWh')
  })
})
