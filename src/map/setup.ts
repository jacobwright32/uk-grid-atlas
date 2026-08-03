/**
 * Map construction + source/layer installation (#54) — the once-only part
 * of GridMap, split out so the component keeps only React wiring.
 */
import maplibregl, { Map as MLMap } from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import type { GridData } from '../lib/types'
import { buildBaseStyle, CARTO_SOURCE } from './style'
import { interconnectorLayers, liveStationLayer, stationLayers, transmissionLayers } from './layers'

// Transmission tiles (#8): one PMTiles archive for all countries, fetched
// by HTTP range requests — only the tiles in view load. The single-file
// build keeps GeoJSON bundles instead (__TILES__ is false there).
if (__TILES__) {
  const protocol = new Protocol()
  maplibregl.addProtocol('pmtiles', protocol.tile)
}
export const TILES_URL = () =>
  `pmtiles://${new URL('tiles/transmission.pmtiles', document.baseURI).href}`

/** Construct the atlas map with its controls (no sources yet). */
export function createAtlasMap(
  container: HTMLDivElement,
  data: GridData,
  bounds: [[number, number], [number, number]],
): MLMap {
  const map = new maplibregl.Map({
    container,
    style: buildBaseStyle(data.basemap),
    bounds,
    fitBoundsOptions: { padding: 24 },
    minZoom: 2,
    maxZoom: 15,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
  })
  map.touchZoomRotate.disableRotation()
  // Sources fail quietly by default: a dropped PMTiles range request would
  // just mean missing lines with no trace. Log once per distinct message —
  // a flaky connection can emit hundreds of identical tile errors.
  const seenErrors = new Set<string>()
  map.on('error', (e) => {
    const msg = String((e as { error?: { message?: string } }).error?.message ?? e)
    if (seenErrors.has(msg)) return
    seenErrors.add(msg)
    console.warn(`map error: ${msg}`)
  })
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
  map.addControl(
    new maplibregl.AttributionControl({
      compact: true,
      customAttribution:
        'Power data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL) · Coastline: Natural Earth',
    }),
    'bottom-right',
  )
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left')
  return map
}

/** Install every source and layer (call from the map's `load` handler). */
export function installSourcesAndLayers(map: MLMap, data: GridData): void {
  // Optional raster underlay slot (kept hidden until toggled).
  map.addSource('carto', CARTO_SOURCE)
  map.addLayer(
    {
      id: 'carto',
      type: 'raster',
      source: 'carto',
      layout: { visibility: 'none' },
      paint: { 'raster-opacity': 0.85 },
    },
    'land',
  )

  if (__TILES__) {
    map.addSource('transmission', {
      type: 'vector',
      url: TILES_URL(),
      minzoom: 2,
      maxzoom: 11, // tiles overzoom beyond their native maximum
    })
  } else {
    map.addSource('transmission', { type: 'geojson', data: data.transmission })
  }
  map.addSource('interconnectors', { type: 'geojson', data: data.interconnectors })
  map.addSource('stations', { type: 'geojson', data: data.stations, generateId: true })

  for (const layer of transmissionLayers('transmission', __TILES__ ? 'transmission' : undefined))
    map.addLayer(layer)
  for (const layer of interconnectorLayers('interconnectors')) map.addLayer(layer)
  for (const layer of stationLayers('stations')) map.addLayer(layer)
  map.addLayer(liveStationLayer('stations'))
}

/** Push a (possibly newer) data snapshot into every GeoJSON source. */
export function setAllSourceData(map: MLMap, data: GridData): void {
  const src = (id: string) => map.getSource(id) as maplibregl.GeoJSONSource | undefined
  src('land')?.setData(data.basemap as never)
  src('stations')?.setData(data.stations as never)
  if (!__TILES__) src('transmission')?.setData(data.transmission as never)
  src('interconnectors')?.setData(data.interconnectors as never)
}
