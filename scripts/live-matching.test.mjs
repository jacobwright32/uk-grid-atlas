// Tokeniser tests for the multilingual ENTSO-E / OSM name matching.
import { describe, expect, it } from 'vitest'
import { jaccard, stemTokens, tokens } from './live-matching.mjs'

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
