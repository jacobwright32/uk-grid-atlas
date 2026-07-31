// @vitest-environment jsdom
// The card is built with DOM APIs, so it needs a document; MapLibre itself is
// never constructed here (it wants WebGL that jsdom hasn't got).
import { describe, expect, it } from 'vitest'
import type { MapGeoJSONFeature } from 'maplibre-gl'
import { stationCard } from './popup'
import type { StationProps } from '../lib/types'

/**
 * stationCard reads `feature.properties` and nothing else off the feature, so a
 * bare properties bag is a faithful stand-in — the alternative is standing up a
 * MapLibre instance to assert on a string.
 */
function feature(props: Partial<StationProps>): MapGeoJSONFeature {
  return {
    properties: { id: 'way/1', name: 'Test site', fuel: 'hydro', ...props },
  } as unknown as MapGeoJSONFeature
}

const sub = (props: Partial<StationProps>) =>
  stationCard(feature(props)).querySelector('.card-sub')?.textContent

describe('stationCard fuel line', () => {
  it('qualifies the fuel label with an informative method', () => {
    expect(sub({ fuel: 'hydro', method: 'run-of-the-river' })).toBe('Hydro · run-of-river')
    expect(sub({ fuel: 'hydro', method: 'water-storage' })).toBe('Hydro · reservoir')
    expect(sub({ fuel: 'bioenergy', method: 'anaerobic_digestion' })).toBe(
      'Bioenergy · anaerobic digestion',
    )
  })

  it('leaves the fuel label alone when the method adds nothing', () => {
    expect(sub({ fuel: 'solar', method: 'photovoltaic' })).toBe('Solar PV')
    expect(sub({ fuel: 'gas', method: 'combustion' })).toBe('Gas')
    expect(sub({ fuel: 'hydro', method: null })).toBe('Hydro')
    // Slimmed bundles omit the key entirely rather than writing null.
    expect(sub({ fuel: 'hydro' })).toBe('Hydro')
  })

  it('still renders a card for a station with no usable fuel', () => {
    // FUEL_LABEL is keyed by FuelId; anything outside it falls back rather than
    // rendering "undefined" into the DOM.
    expect(sub({ fuel: 'not-a-fuel' as StationProps['fuel'] })).toBe('Power station')
  })

  it('writes OSM free text as text, never markup', () => {
    // The whole card is built with textContent for this reason — a name like
    // this must not become an element.
    const card = stationCard(feature({ name: '<img src=x onerror=alert(1)>' }))
    expect(card.querySelector('img')).toBeNull()
    expect(card.querySelector('.card-title')?.textContent).toBe('<img src=x onerror=alert(1)>')
  })
})
