import { describe, expect, it } from 'vitest'
import { isBaked, mixTitleFor, SOURCE_META, sourceMetaFor } from './sources'

describe('sourceMetaFor (#53)', () => {
  it('falls back to ENTSO-E for unlabelled or unknown sources', () => {
    expect(sourceMetaFor(null).label).toBe('ENTSO-E')
    expect(sourceMetaFor(undefined).unitThreshold).toBe(true)
    expect(sourceMetaFor('Mystery Grid Co').label).toBe('ENTSO-E')
  })
  it('resolves the North American sources with their regions', () => {
    expect(sourceMetaFor('IESO').regionName).toBe('Ontario')
    expect(sourceMetaFor('ERCOT + NYISO').regionName).toBe('Texas + New York')
    for (const meta of Object.values(SOURCE_META)) {
      expect(meta.footnote).toBeTruthy()
      expect(meta.unitThreshold).toBe(false) // only ENTSO-E has the 100 MW cut
    }
  })
})

describe('isBaked / mixTitleFor (#53)', () => {
  const baked = (sourceLabel: string | null) => ({ basis: 'entsoe', sourceLabel })
  it('discriminates the two data shapes', () => {
    expect(isBaked(baked(null))).toBe(true)
    expect(isBaked({ basis: 'elexon' })).toBe(false)
    expect(isBaked(null)).toBe(false)
  })
  it('titles panels by source region, falling back to the country', () => {
    expect(mixTitleFor('Finland', baked(null))).toBe('Finland generation mix')
    expect(mixTitleFor('Canada', baked('IESO'))).toBe('Ontario generation mix')
    expect(mixTitleFor('United States', baked('ERCOT + NYISO'))).toBe(
      'Texas + New York generation mix',
    )
    expect(mixTitleFor('United Kingdom', { basis: 'elexon', sourceLabel: null })).toBe(
      'GB transmission mix',
    )
  })
})
