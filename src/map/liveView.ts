/**
 * Live output + HVDC flow application (#54): sizes station dots by output
 * (live, scrubbed interval, or week-scrub series) and rebuilds the
 * interconnector source with flow direction/utilisation properties.
 * Pure map mutation — GridMap calls these from its effects.
 */
import type maplibregl from 'maplibre-gl'
import type { Map as MLMap } from 'maplibre-gl'
import type { CountryConfig } from '../lib/countries'
import type { GridData } from '../lib/types'
import type { LiveData } from '../lib/live'

/** Week-scrub series (#65): timeIndex indexes these instead of the day's. */
export interface WeekScrubData {
  perStation: Map<string, (number | null)[]> | null
  flowSeries: Record<string, (number | null)[]> | null
}

export interface LiveViewArgs {
  data: GridData
  country: CountryConfig
  live: LiveData | null
  liveMode: boolean
  timeIndex: number | null
  weekScrub: WeekScrubData | null
}

export function applyLiveView(map: MLMap, args: LiveViewArgs): void {
  const { data, country, live, liveMode, timeIndex, weekScrub } = args
  // Mix-only snapshots (Nordics: no per-unit ENTSO-E feed) must not ghost
  // the station dots — live sizing needs actual per-station figures.
  const hasStationData =
    live != null && ((live.perStationNow?.size ?? 0) > 0 || live.perStationDay.size > 0)
  const showLive = liveMode && country.hasLive && hasStationData
  if (map.getLayer('stations-live')) {
    map.setLayoutProperty('stations-live', 'visibility', showLive ? 'visible' : 'none')
  }
  if (map.getLayer('stations')) {
    map.setPaintProperty(
      'stations',
      'circle-opacity',
      showLive
        ? 0.22
        : (['case', ['boolean', ['feature-state', 'hover'], false], 1, 0.85] as never),
    )
  }
  applyFlowView(map, args)
  if (!live || !showLive) return
  // Feature ids from generateId are the feature's index in source order.
  data.stations.features.forEach((f, index) => {
    const id = f.properties.id
    let mw: number
    if (timeIndex != null && weekScrub) {
      // Week scrub (#65): read the stitched week series; grids without
      // per-station history keep their day-average sizing while the mix
      // panel does the scrubbing.
      mw = weekScrub.perStation
        ? (weekScrub.perStation.get(id)?.[timeIndex] ?? 0)
        : (live.perStationNow?.get(id) ?? live.perStationDay.get(id)?.avgMW ?? 0)
    } else if (timeIndex != null) {
      // Scrub mode (#17): show the selected interval of the metered day.
      mw = live.perStationDay.get(id)?.series[timeIndex] ?? 0
    } else {
      mw = live.perStationNow?.get(id) ?? live.perStationDay.get(id)?.avgMW ?? 0
    }
    map.setFeatureState({ source: 'stations', id: index }, { liveMW: Math.max(0, mw) })
  })
}

/**
 * #43: normalized flows — the dashed HVDC base gets a solid overlay where a
 * flow is known (+ = import into the page country), scrub-aware via
 * flowSeries. Runs even for mix-only countries (they have flows, no dots).
 */
export function applyFlowView(map: MLMap, args: LiveViewArgs): void {
  const { data, country, live, liveMode, timeIndex, weekScrub } = args
  const src = map.getSource('interconnectors') as maplibregl.GeoJSONSource | undefined
  if (!src) return
  const flowsNow = live?.mix?.interconnectors ?? null
  const series = live?.flowSeries ?? null
  const wantFlows = liveMode && country.hasLive && (flowsNow || series)
  const features = data.interconnectors.features.map((f) => {
    if (!wantFlows || f.properties.status !== 'operational') return f
    const id = f.properties.id as string
    const mw =
      timeIndex != null && weekScrub
        ? (weekScrub.flowSeries?.[id]?.[timeIndex] ?? null)
        : timeIndex != null
          ? (series?.[id]?.[timeIndex] ?? null)
          : (flowsNow?.[id] ?? null)
    if (mw == null || Math.abs(mw) < 1) return f
    const util = Math.min(1, Math.abs(mw) / Math.max(1, f.properties.capMW as number))
    return {
      ...f,
      properties: {
        ...f.properties,
        flowMW: Math.round(mw),
        flowDir: mw >= 0 ? 'in' : 'out',
        flowUtil: Math.round(util * 100) / 100,
      },
    }
  })
  src.setData({ type: 'FeatureCollection', features } as never)
}
