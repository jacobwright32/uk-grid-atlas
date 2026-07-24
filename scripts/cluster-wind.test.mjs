// Wind-cluster helper pins (#48): turbineMW's decimal-comma mode and kW/W
// scale clamp are what keep a 173 GW phantom fleet out of the atlas.
import { describe, expect, it } from 'vitest'
import { stripUnit, turbineMW } from './cluster-wind.mjs'

describe('turbineMW', () => {
  it('parses ordinary ratings', () => {
    expect(turbineMW('3 MW')).toBe(3)
    expect(turbineMW('3.45 MW')).toBeCloseTo(3.45)
    expect(turbineMW('12')).toBe(12) // plausible bare MW
  })
  it('decimal-comma mode stays on after the boolean fix (#48)', () => {
    expect(turbineMW('2,5 MW')).toBeCloseTo(2.5) // continental "2,5" = 2.5, not 25
    expect(turbineMW('4,2MW')).toBeCloseTo(4.2)
  })
  it('clamps bare kW and W tags down to turbine scale', () => {
    expect(turbineMW('2000')).toBe(2) // bare kW (the Canadian fleet bug)
    expect(turbineMW('3000 kW')).toBe(3)
    expect(turbineMW('2000000')).toBe(2) // bare watts → two clamp steps
  })
  it('rejects junk and implausibly small ratings', () => {
    expect(turbineMW(null)).toBeNull()
    expect(turbineMW('yes')).toBeNull()
    expect(turbineMW('0.02 MW')).toBeNull() // < 50 kW is not a grid turbine
  })
})

describe('stripUnit', () => {
  it('strips trailing unit numbers and designators', () => {
    expect(stripUnit('Kooninkulma 4')).toBe('Kooninkulma')
    expect(stripUnit('Mäkikangas WTG 7')).toBe('Mäkikangas')
    expect(stripUnit('Sandbank T3')).toBe('Sandbank')
    expect(stripUnit('Delfzijl Noord #12')).toBe('Delfzijl Noord')
  })
  it('strips trailing roman phase numerals', () => {
    expect(stripUnit('Piiparinmäki II')).toBe('Piiparinmäki')
  })
  it('leaves plain farm names alone', () => {
    expect(stripUnit('Whitelee')).toBe('Whitelee')
  })
})
