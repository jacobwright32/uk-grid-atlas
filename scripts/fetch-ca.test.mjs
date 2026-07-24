// IESO snapshot helper pins: stationStem drives every Ontario unit→station
// match, so its stripping rules are load-bearing.
import { describe, expect, it } from 'vitest'
import { FUEL_COMPAT, FUEL_KEY, stationStem } from './fetch-ca-snapshot.mjs'
import { BUCKET_META } from './snapshot-common.mjs'

describe('stationStem', () => {
  it('strips unit designators', () => {
    expect(stationStem('HARMON-G2')).toBe('harmon')
    expect(stationStem('LENNOX-G3')).toBe('lennox')
    expect(stationStem('NANTICOKE-U5')).toBe('nanticoke')
    expect(stationStem('ATIKOKAN-G1')).toBe('atikokan')
  })
  it('splits trailing station letters so Bruce A/B share a stem family', () => {
    expect(stationStem('BRUCEA-G1')).toBe('bruce a')
    expect(stationStem('BRUCEB-G7')).toBe('bruce b')
    expect(stationStem('PICKERING-G5')).toBe('pickering')
  })
  it('passes through names without designators', () => {
    expect(stationStem('PORTDOVER')).toBe('portdover')
  })
})

describe('fuel tables', () => {
  it('every IESO fuel maps to a snapshot bucket and a compat list', () => {
    expect(Object.keys(FUEL_KEY).sort()).toEqual(Object.keys(FUEL_COMPAT).sort())
    for (const key of Object.values(FUEL_KEY)) {
      expect(BUCKET_META[key], `bucket ${key}`).toBeTruthy()
    }
    for (const fuels of Object.values(FUEL_COMPAT)) {
      expect(fuels.length).toBeGreaterThan(0)
    }
  })
})
