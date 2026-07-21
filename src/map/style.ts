import type { StyleSpecification } from 'maplibre-gl'
import type { FeatureCollection } from 'geojson'

export const SEA = '#0b0f14'
export const LAND = '#1a1a19'
export const COAST = '#31312e'

/**
 * Self-contained dark basemap: sea colour + Natural Earth land polygons.
 * No external tiles, glyphs or sprites — works offline and in the
 * single-file build. An optional CARTO raster underlay can be toggled on
 * top of it at runtime (see GridMap).
 */
export function buildBaseStyle(basemap: FeatureCollection): StyleSpecification {
  return {
    version: 8,
    name: 'uk-grid-dark',
    sources: {
      land: { type: 'geojson', data: basemap },
    },
    layers: [
      { id: 'sea', type: 'background', paint: { 'background-color': SEA } },
      {
        id: 'land',
        type: 'fill',
        source: 'land',
        paint: { 'fill-color': LAND },
      },
      {
        id: 'coast',
        type: 'line',
        source: 'land',
        paint: { 'line-color': COAST, 'line-width': 0.8 },
      },
    ],
  }
}

/** CARTO dark raster underlay (online only, optional). */
export const CARTO_SOURCE = {
  type: 'raster' as const,
  tiles: [
    'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
    'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
    'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
  ],
  tileSize: 256,
  attribution: '© <a href="https://carto.com/attributions">CARTO</a> © OpenStreetMap contributors',
}
