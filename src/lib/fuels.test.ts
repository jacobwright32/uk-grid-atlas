import { describe, expect, it } from 'vitest'
import { FUEL_COLOR, FUEL_LABEL, FUEL_TO_GROUP, GROUPS, fuelColorExpression } from './fuels'
import type { FuelId } from './types'

const ALL_FUELS: FuelId[] = [
  'gas',
  'nuclear',
  'wind_offshore',
  'wind_onshore',
  'solar',
  'hydro',
  'pumped',
  'marine',
  'bioenergy',
  'waste',
  'storage',
  'oil',
  'coal',
  'other',
]

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
