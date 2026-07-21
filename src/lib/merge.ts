import type { GridData } from './types'

/**
 * Merge several countries' bundles into one map view.
 * Interconnectors are deduped by id — shared links (BritNed, Viking,
 * COBRA, Nemo, Celtic…) exist in both endpoint countries' bundles.
 */
export function mergeGridData(bundles: GridData[]): GridData {
  if (!bundles.length) throw new Error('mergeGridData: nothing to merge')
  const first = bundles[0]!
  const seenIc = new Set<string>()
  const interconnectors = {
    type: 'FeatureCollection' as const,
    features: bundles.flatMap((b) =>
      b.interconnectors.features.filter((f) => {
        if (seenIc.has(f.properties.id)) return false
        seenIc.add(f.properties.id)
        return true
      }),
    ),
  }

  // Merge distinct region basemaps (per-region objects are cached/shared,
  // so reference identity is a safe dedupe key).
  const seenBm = new Set<object>()
  const basemap = {
    type: 'FeatureCollection' as const,
    features: bundles.flatMap((b) => {
      if (seenBm.has(b.basemap)) return []
      seenBm.add(b.basemap)
      return b.basemap.features
    }),
  }

  return {
    stations: {
      type: 'FeatureCollection',
      features: bundles.flatMap((b) => b.stations.features),
    },
    transmission: {
      type: 'FeatureCollection',
      features: bundles.flatMap((b) => b.transmission.features),
    },
    interconnectors,
    basemap,
    meta: {
      generated: first.meta.generated,
      stationCount: bundles.reduce((a, b) => a + b.meta.stationCount, 0),
      lineCount: bundles.reduce((a, b) => a + b.meta.lineCount, 0),
      attribution: first.meta.attribution,
    },
  }
}
