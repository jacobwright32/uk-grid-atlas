// Tokeniser tests for the multilingual ENTSO-E / OSM name matching.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BROAD_MIN_SCORE,
  COMPAT,
  MIN_SCORE,
  compatible,
  isNearTie,
  jaccard,
  matchUnit,
  resetUnknownFuels,
  stemTokens,
  tokens,
  unknownFuelCounts,
} from './live-matching.mjs'
import { MIX_FUELS } from '../src/lib/live-core.mjs'

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

describe('compatible (#56, tightened in #11)', () => {
  beforeEach(() => resetUnknownFuels())
  afterEach(() => vi.restoreAllMocks())

  it('gates BMU fuel onto plausible station fuels only', () => {
    expect(compatible('NUCLEAR', 'nuclear')).toBe(true)
    expect(compatible('NUCLEAR', 'gas')).toBe(false)
    expect(compatible('WIND', 'wind_offshore')).toBe(true)
    expect(compatible('WIND', 'coal')).toBe(false)
    expect(compatible('PS', 'pumped')).toBe(true)
  })
  it('a declared OTHER or a missing fuelType keeps the broad list', () => {
    // real OTHER units: batteries, tidal, CHP oddities, unreclassified wind
    expect(compatible('OTHER', 'storage')).toBe(true)
    expect(compatible('OTHER', 'marine')).toBe(true)
    expect(compatible('OTHER', 'wind_offshore')).toBe(true)
    expect(compatible(null, 'storage')).toBe(true)
    expect(compatible(undefined, 'storage')).toBe(true)
  })
  it('an unrecognised code inherits nothing, broad list included (#11)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(compatible('MYSTERY', 'gas')).toBe(false)
    expect(compatible('B20', 'storage')).toBe(false) // ENTSO-E code in an Elexon field
    expect(compatible('CGGT', 'gas')).toBe(false) // typo, not a licence to guess
  })
  it('never nuclear (or coal) by accident, whatever the code', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(compatible('MYSTERY', 'nuclear')).toBe(false)
    expect(compatible('OTHER', 'nuclear')).toBe(false)
    expect(compatible(null, 'nuclear')).toBe(false)
    expect(compatible('OTHER', 'coal')).toBe(false)
  })
  it('warns once per distinct unknown code and tallies the attempts (#11)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    compatible('MYSTERY', 'gas')
    compatible('MYSTERY', 'oil')
    compatible('B20', 'gas')
    expect(warn).toHaveBeenCalledTimes(2) // one line per distinct code, not per call
    expect(warn.mock.calls[0][0]).toContain('MYSTERY')
    expect(unknownFuelCounts()).toEqual({ MYSTERY: 2, B20: 1 })
  })
  it('COMPAT covers every Elexon fuel code the app renders (#11)', () => {
    // the strict rule is only safe while the table is complete: a code in the
    // mix strip but not in COMPAT would stop matching altogether
    for (const [code] of MIX_FUELS) expect(COMPAT[code], `compat ${code}`).toBeTruthy()
    expect(BROAD_MIN_SCORE).toBeGreaterThan(MIN_SCORE)
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

describe('matchUnit fuel-code strictness (#11)', () => {
  const index = [
    { id: 'sofia', fuel: 'wind_offshore', toks: tokens('Sofia Offshore Wind Farm') },
    { id: 'thurcroft', fuel: 'storage', toks: tokens('Thurcroft Battery Storage') },
    { id: 'sizewell', fuel: 'nuclear', toks: tokens('Sizewell B Nuclear Power Station') },
  ]
  beforeEach(() => resetUnknownFuels())
  afterEach(() => vi.restoreAllMocks())

  it('still places a declared OTHER unit on the site it belongs to', () => {
    // Sofia registered as OTHER before its wind reclassification — the case
    // the broad list exists for
    expect(matchUnit({ bmUnitName: 'SOFIA-1', fuelType: 'OTHER' }, index)?.stationId).toBe('sofia')
    expect(
      matchUnit({ bmUnitName: 'Thurcroft Battery Storage', fuelType: 'OTHER' }, index)?.stationId,
    ).toBe('thurcroft')
    expect(matchUnit({ bmUnitName: 'Sofia 2', fuelType: null }, index)?.stationId).toBe('sofia')
  })
  it('holds broad-list matches to BROAD_MIN_SCORE, not MIN_SCORE', () => {
    // 'Kings Lynn' shares 2 of the gas station's 3 tokens = 0.67: over the
    // 0.55 bar a confident fuel gate still uses, under the new broad 0.7
    const twin = [
      { id: 'klyn-gas', fuel: 'gas', toks: tokens('Kings Lynn Alpha Power Station') },
      { id: 'klyn-bess', fuel: 'storage', toks: tokens('Kings Lynn Alpha Battery') },
    ]
    expect(matchUnit({ bmUnitName: 'Kings Lynn', fuelType: 'CCGT' }, twin)?.stationId).toBe(
      'klyn-gas',
    )
    expect(compatible('OTHER', 'storage')).toBe(true) // the fuel gate still allows it …
    expect(matchUnit({ bmUnitName: 'Kings Lynn', fuelType: 'OTHER' }, twin)).toBeNull() // … the score doesn't
  })
  it('refuses to match an unrecognised code even on a perfect name (#11)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(matchUnit({ bmUnitName: 'Sofia Offshore Wind Farm', fuelType: 'B20' }, index)).toBeNull()
    expect(
      matchUnit({ bmUnitName: 'Thurcroft Battery Storage', fuelType: 'BATT' }, index),
    ).toBeNull()
    expect(warn).toHaveBeenCalledTimes(2)
    expect(unknownFuelCounts()).toEqual({ B20: 1, BATT: 1 })
  })
  it('never lands a non-nuclear unit on a nuclear station', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(matchUnit({ bmUnitName: 'Sizewell B', fuelType: 'OTHER' }, index)).toBeNull()
    expect(matchUnit({ bmUnitName: 'Sizewell B', fuelType: 'MYSTERY' }, index)).toBeNull()
    expect(matchUnit({ bmUnitName: 'Sizewell B', fuelType: null }, index)).toBeNull()
  })
  it('surfaces the runner-up so ambiguous wins can be reported', () => {
    const twins = [
      { id: 'walney-a', fuel: 'wind_offshore', toks: tokens('Walney Wind Farm') },
      { id: 'walney-b', fuel: 'wind_offshore', toks: tokens('Walney Offshore Windfarm') },
    ]
    const tie = matchUnit({ bmUnitName: 'Walney 1', fuelType: 'WIND' }, twins)
    expect(tie.stationId).toBe('walney-a') // first of two identically-named sites
    expect(tie.runnerUp.stationId).toBe('walney-b')
    expect(isNearTie(tie)).toBe(true)
    // an unambiguous win has no near-tie runner-up
    const clear = matchUnit({ bmUnitName: 'Sofia 1', fuelType: 'WIND' }, index)
    expect(clear.runnerUp).toBeNull()
    expect(isNearTie(clear)).toBe(false)
  })
})
