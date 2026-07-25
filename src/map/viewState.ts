/**
 * Filter / visibility application (#54): pushes the sidebar's toggles and
 * the country's voltage tiers into layer filters. Pure map mutation — no
 * React, no component state.
 */
import type { Map as MLMap } from 'maplibre-gl'
import type { CountryConfig } from '../lib/countries'
import type { GroupId, NetworkToggles } from '../lib/types'
import { stationFilter } from '../lib/filter'

export interface ViewStateArgs {
  country: CountryConfig
  enabledGroups: ReadonlySet<GroupId>
  network: NetworkToggles
  tiles: boolean
}

export function applyViewState(
  map: MLMap,
  { country, enabledGroups, network, tiles }: ViewStateArgs,
): void {
  map.setFilter('stations', stationFilter(enabledGroups) as never)
  if (map.getLayer('stations-live'))
    map.setFilter('stations-live', stationFilter(enabledGroups) as never)

  const vis = (id: string, on: boolean) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')
  }
  const tierIds = ['lines-t1', 'lines-t2', 'lines-t3'] as const
  const tierOn = [network.t1, network.t2, network.t3] as const
  country.tiers.forEach((tier, i) => {
    const id = tierIds[i]!
    if (!map.getLayer(id)) return
    const kvFilter = ['in', ['get', 'v'], ['literal', tier.kvs]]
    // One shared tile archive holds every country's lines — single-country
    // pages filter to their own (the ALL view shows the lot).
    const filter =
      __TILES__ && country.id !== 'all'
        ? ['all', kvFilter, ['==', ['get', 'cc'], country.id]]
        : kvFilter
    map.setFilter(id, filter as never)
    vis(id, tierOn[i]! && tier.kvs.length > 0)
  })
  vis('hvdc', network.hvdc)
  if (map.getLayer('hvdc')) {
    map.setFilter(
      'hvdc',
      network.construction ? null : (['==', ['get', 'status'], 'operational'] as never),
    )
  }
  vis('carto', tiles)
  if (map.getLayer('land')) {
    map.setPaintProperty('land', 'fill-opacity', tiles ? 0 : 1)
    map.setPaintProperty('coast', 'line-opacity', tiles ? 0.25 : 1)
  }
}
