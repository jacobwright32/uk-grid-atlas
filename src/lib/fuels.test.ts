import { describe, expect, it } from 'vitest'
import {
  FUEL_COLOR,
  FUEL_LABEL,
  FUEL_TO_GROUP,
  GROUPS,
  METHOD_RULES,
  fuelColorExpression,
  methodLabel,
} from './fuels'
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

/** Derived from the table, so a rule added later is checked without an edit here. */
const KNOWN_METHODS = Object.keys(METHOD_RULES)

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

describe('plant:method qualifier', () => {
  it('names the hydro behaviour that the fuel label cannot', () => {
    // The point of the whole feature: 3,213 run-of-river vs 1,685 reservoir
    // sites are indistinguishable on the map without this.
    expect(methodLabel('hydro', 'run-of-the-river')).toBe('run-of-river')
    expect(methodLabel('hydro', 'water-storage')).toBe('reservoir')
  })

  it('drops methods that only restate the fuel', () => {
    // These four cover 41,240 of the 47,891 tagged stations. Rendering any of
    // them would put "Solar PV · photovoltaic" on 34,695 cards.
    expect(methodLabel('solar', 'photovoltaic')).toBeNull()
    expect(methodLabel('gas', 'combustion')).toBeNull()
    expect(methodLabel('wind_onshore', 'wind_turbine')).toBeNull()
    expect(methodLabel('nuclear', 'fission')).toBeNull()
    // Pumped-storage's method is already in its fuel label.
    expect(methodLabel('pumped', 'water-pumped-storage')).toBeNull()
  })

  it('gates each method on the fuels it makes sense for', () => {
    // `thermal` is concentrating solar on a solar plant. On the five gas and
    // four bioenergy plants that also claim it, it means nothing publishable.
    expect(methodLabel('solar', 'thermal')).toBe('concentrating')
    expect(methodLabel('gas', 'thermal')).toBeNull()
    expect(methodLabel('bioenergy', 'thermal')).toBeNull()
    // Mis-tags in the real data: a hydro plant claiming combustion, a pumped
    // site claiming run-of-river. Neither should reach a card.
    expect(methodLabel('hydro', 'combustion')).toBeNull()
    expect(methodLabel('pumped', 'run-of-the-river')).toBeNull()
  })

  it('reads multi-valued tags back as a list, deduped', () => {
    expect(methodLabel('hydro', 'water-storage;run-of-the-river')).toBe('reservoir + run-of-river')
    // Unknown tokens are dropped, not passed through.
    expect(methodLabel('solar', 'photovoltaic;wind_turbine')).toBeNull()
    expect(methodLabel('solar', 'thermal;photovoltaic')).toBe('concentrating')
    // Both separators OSM uses in this field, and a repeated token.
    expect(methodLabel('solar', 'photovoltaic / thermal')).toBe('concentrating')
    expect(methodLabel('hydro', 'water-storage;water-storage')).toBe('reservoir')
  })

  it('returns null for absent, empty and unrecognised values', () => {
    expect(methodLabel('hydro', null)).toBeNull()
    expect(methodLabel('hydro', undefined)).toBeNull()
    expect(methodLabel('hydro', '')).toBeNull()
    // Typos and non-English tags that exist upstream today.
    expect(methodLabel('hydro', 'průběh_řekyw')).toBeNull()
    expect(methodLabel('storage', 'batteriespeicher')).toBeNull()
  })

  it('never emits a qualifier that just echoes the fuel label', () => {
    // A rule whose label repeats its own fuel label is a no-op that reads like
    // a feature — this catches one being added later.
    for (const fuel of ALL_FUELS) {
      for (const method of KNOWN_METHODS) {
        const q = methodLabel(fuel, method)
        if (q == null) continue
        for (const part of q.split(' + ')) {
          expect(part.toLowerCase(), `${fuel}/${method}`).not.toBe(FUEL_LABEL[fuel].toLowerCase())
        }
      }
    }
  })
})
