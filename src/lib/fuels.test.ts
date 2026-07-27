import { describe, expect, it } from 'vitest'
import { FUEL_COLOR, FUEL_LABEL, FUEL_TO_GROUP, GROUPS, fuelColorExpression } from './fuels'
import type { FuelId } from './types'

/**
 * Derived, never hand-listed (#39): `satisfies Record<FuelId, true>` makes a
 * missing key a type error, so adding a fuel to `FuelId` can't silently skip
 * the exhaustiveness checks below the way 'geothermal' did.
 */
const FUEL_IDS = {
  gas: true,
  nuclear: true,
  wind_offshore: true,
  wind_onshore: true,
  solar: true,
  hydro: true,
  pumped: true,
  marine: true,
  bioenergy: true,
  waste: true,
  storage: true,
  oil: true,
  coal: true,
  geothermal: true,
  other: true,
} satisfies Record<FuelId, true>

const ALL_FUELS = Object.keys(FUEL_IDS) as FuelId[]

describe('fuel taxonomy integrity', () => {
  it('every granular fuel maps to a display group', () => {
    for (const fuel of ALL_FUELS) {
      expect(FUEL_TO_GROUP.get(fuel), `group for ${fuel}`).toBeDefined()
    }
  })

  it('every granular fuel has a colour and a label', () => {
    for (const fuel of ALL_FUELS) {
      expect(FUEL_COLOR.get(fuel), `colour for ${fuel}`).toMatch(/^#[0-9a-f]{6}$/i)
      expect(FUEL_LABEL[fuel], `label for ${fuel}`).toBeTruthy()
    }
  })

  it('group ids are unique and colours are unique per group', () => {
    const ids = GROUPS.map((g) => g.id)
    expect(new Set(ids).size).toBe(ids.length)
    const colors = GROUPS.map((g) => g.color)
    expect(new Set(colors).size).toBe(colors.length)
  })

  it('colour match expression covers every fuel and ends with a fallback', () => {
    const expr = fuelColorExpression()
    expect(expr[0]).toBe('match')
    // ['match', input, k1, v1, ..., fallback] → odd length
    expect(expr.length % 2).toBe(1)
    for (const fuel of ALL_FUELS) expect(expr).toContain(fuel)
  })
})
