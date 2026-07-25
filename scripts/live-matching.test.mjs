// Tokeniser tests for the multilingual ENTSO-E / OSM name matching.
import { describe, expect, it } from 'vitest'
import { compatible, jaccard, matchUnit, stemTokens, tokens } from './live-matching.mjs'

describe('tokens (multilingual)', () => {
  it('strips French plant-name boilerplate', () => {
    expect(tokens("Centre Nucléaire de Production d'Electricité de Paluel")).toEqual(['paluel'])
    expect(tokens('Centrale thermique de Martigues')).toEqual(['martigues'])
    expect(tokens("Barrage-usine de l'Aigle")).toEqual(['aigle'])
  })
  it('folds Germanic and Nordic letters the way ENTSO-E spells them', () => {
    expect(tokens('Skærbækværket')).toEqual(['skaerbaekvaerket'])
    expect(tokens('Skaerbaekvaerket 3')).toEqual(['skaerbaekvaerket', '3'])
    expect(tokens('Kraftwerk Lünen')).toEqual(['luenen'])
    expect(tokens('Großkraftwerk Mannheim')).toEqual(['mannheim'])
  })
  it('aliases roman numerals and St', () => {
    expect(tokens('Rødsand II Havmøllepark')).toEqual(['roedsand', '2'])
    expect(tokens('ST ALBAN 1')).toEqual(['saint', 'alban', '1'])
    expect(tokens('Centrale nucléaire de Saint-Alban')).toEqual(['saint', 'alban'])
  })
  it('unglues the Dutch -centrale suffix', () => {
    expect(tokens('Clauscentrale')).toEqual(['claus'])
    expect(tokens('Amercentrale')).toEqual(['amer'])
    // but the bare word "centrale" is just a stopword
    expect(tokens('Centrale Ringvaart')).toEqual(['ringvaart'])
  })
  it('keeps GB behaviour intact', () => {
    expect(tokens('Drax Power Station')).toEqual(['drax'])
    expect(tokens('London Array Wind Farm')).toEqual(['london', 'array'])
  })
})

describe('matching end to end', () => {
  const score = (a, b) => {
    const ta = tokens(a)
    return Math.max(jaccard(ta, tokens(b)), jaccard(stemTokens(ta), tokens(b)))
  }
  it('matches the pairs that motivated the fix', () => {
    expect(
      score('PALUEL 1', "Centre Nucléaire de Production d'Electricité de Paluel"),
    ).toBeGreaterThanOrEqual(0.5)
    expect(score('Claus C', 'Clauscentrale')).toBeGreaterThanOrEqual(0.5)
    expect(score('WALSUM_10', 'Kraftwerk Duisburg-Walsum')).toBeGreaterThanOrEqual(0.5)
    expect(score('Roedsand 2', 'Rødsand II Havmøllepark')).toBeGreaterThanOrEqual(0.5)
    expect(score('Anholt', 'Anholt Havmøllepark')).toBeGreaterThanOrEqual(0.5)
  })
  it('does not cross-match unrelated plants', () => {
    expect(score('PALUEL 1', 'Centrale nucléaire de Flamanville')).toBe(0)
    expect(score('Claus C', 'Centrale Hemweg')).toBe(0)
  })
})

describe('compatible (#56)', () => {
  it('gates BMU fuel onto plausible station fuels only', () => {
    expect(compatible('NUCLEAR', 'nuclear')).toBe(true)
    expect(compatible('NUCLEAR', 'gas')).toBe(false)
    expect(compatible('WIND', 'wind_offshore')).toBe(true)
    expect(compatible('WIND', 'coal')).toBe(false)
    expect(compatible('PS', 'pumped')).toBe(true)
  })
  it('unknown or missing fuel falls back to the broad OTHER list', () => {
    expect(compatible(null, 'storage')).toBe(true)
    expect(compatible('MYSTERY', 'gas')).toBe(true)
    expect(compatible('MYSTERY', 'nuclear')).toBe(false) // never nuclear by accident
  })
})

describe('matchUnit (#56)', () => {
  const index = [
    { id: 'drax', fuel: 'bioenergy', toks: tokens('Drax Power Station') },
    { id: 'drax-gas', fuel: 'gas', toks: tokens('Drax CCGT') },
    { id: 'hornsea', fuel: 'wind_offshore', toks: tokens('Hornsea Project One') },
    { id: 'dinorwig', fuel: 'pumped', toks: tokens('Dinorwig Power Station') },
  ]
  it('picks the best-scoring compatible station', () => {
    expect(matchUnit({ bmUnitName: 'DRAX-1', fuelType: 'BIOMASS' }, index)?.stationId).toBe('drax')
    expect(matchUnit({ bmUnitName: 'Hornsea One', fuelType: 'WIND' }, index)?.stationId).toBe(
      'hornsea',
    )
    expect(matchUnit({ bmUnitName: 'Dinorwig 5', fuelType: 'PS' }, index)?.stationId).toBe(
      'dinorwig',
    )
  })
  it('fuel gating separates co-named stations', () => {
    // the biomass unit lands on the biomass site, not the same-named CCGT
    const m = matchUnit({ bmUnitName: 'Drax 12', fuelType: 'COAL' }, index)
    expect(m?.stationId).toBe('drax') // COAL compat includes bioenergy, not gas
    expect(matchUnit({ bmUnitName: 'Drax GT', fuelType: 'CCGT' }, index)?.stationId).toBe(
      'drax-gas',
    )
  })
  it('returns null when nothing compatible clears the threshold', () => {
    expect(matchUnit({ bmUnitName: 'Sizewell B', fuelType: 'NUCLEAR' }, index)).toBeNull()
    expect(matchUnit({ bmUnitName: 'ZZ_UNKNOWN-9', fuelType: 'WIND' }, index)).toBeNull()
  })
})
